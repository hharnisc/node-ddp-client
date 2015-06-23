_ = require('underscore')
EventEmitter = require('events').EventEmitter
EJSON = require("ejson")

class DDPClient extends EventEmitter
  constructor: (opts) ->
    opts = opts ? {}

    # default arguments
    @host = opts.host ? "localhost"
    @port = opts.port ? 3000
    @path = opts.path
    @ssl = opts.ssl ? @port is 443
    @tlsOpts = opts.tlsOpts ? {}
    @autoReconnect = opts.autoReconnect ? true
    @autoReconnectTimer = opts.autoReconnectTimer ? 500
    @cache = opts.cache ? null
    @url = opts.url
    @socketConstructor = opts.socketConstructor ? WebSocket

    # support multiple ddp versions
    @ddpVersion = if "ddpVersion" in opts then opts.ddpVersion else "1"
    @supportedDdpVersions = ["1", "pre2", "pre1"]

    # Expose EJSON object, so client can use EJSON.addType(...)
    @EJSON = EJSON

    # internal stuff to track callbacks
    @_isConnecting = false
    @_isReconnecting = false
    @_nextId = 0
    @_callbacks = {}
    @_updatedCallbacks = {}
    @_pendingMethods = {}


  _prepareHandlers: ->
    @socket.onopen = =>
      # just go ahead and open the connection on connect
      @_send(
        msg: "connect"
        version: @ddpVersion
        support: @supportedDdpVersions
      )

    @socket.onerror = (error) =>
      # error received before connection was established
      @emit("failed", error.message) if (@_isConnecting)
      @emit("socket-error", error)

    @socket.onclose = (event) =>
      @emit("socket-close", event.code, event.reason)
      @_endPendingMethodCalls()
      @_recoverNetworkError()

    @socket.onmessage = (event) =>
      @_message(event.data)
      @emit("message", event.data)


  _clearReconnectTimeout: ->
    if self.reconnectTimeout
      clearTimeout(@reconnectTimeout)
      self.reconnectTimeout = null

  _recoverNetworkError: ->
    if @autoReconnect and not @_connectionFailed and not @_isClosing
      @_clearReconnectTimeout()
      connectWrapper = => @connect()
      @reconnectTimeout = setTimeout connectWrapper, @autoReconnectTimer
      @_isReconnecting = true


  #########################
  # RAW, low level functions
  #########################
  _send: (data) -> @socket.send(EJSON.stringify(data))

  # handle a message from the server
  _message: (data) ->
    data = EJSON.parse(data)
    # TODO: 'addedBefore' -- not yet implemented in Meteor
    # TODO: 'movedBefore' -- not yet implemented in Meteor

    return if not data.msg?

    switch data.msg
      when "failed"
        if @supportedDdpVersions.indexOf(data.version) isnt -1
          @ddpVersion = data.version
          @connect()
        else
          @autoReconnect = false
          @emit("failed", "Cannot negotiate DDP version")

      when "connected"
        @session = data.session
        @emit("connected")

      # method result
      when "result"
        cb = @_callbacks[data.id]
        if cb
          cb(data.error, data.result)
          delete @_callbacks[data.id]

      # method updated
      when "updated"
        _.each data.methods, (method) =>
          cb = @_updatedCallbacks[method]
          if (cb)
            cb()
            delete @_updatedCallbacks[method]

      # missing subscription
      when "nosub"
        cb = @_callbacks[data.id]

        if (cb)
          cb(data.error)
          delete @_callbacks[data.id]

      # add document to collection
      when "added"
        if @cache? and data.collection
          name = data.collection
          id = data.id
          item =
            "_id": id

          if data.fields
            _.each data.fields, (value, key) ->
              item[key] = value
          if not @cache[name]
            @cache.addCollection(name)
          @cache[name].upsert(item)

      # remove document from collection
      when "removed"
        if @cache? and data.collection
          name = data.collection
          id = data.id

          @cache[name].remove({"_id": id})

      # change document in collection
      when "changed"
        if @cache? && data.collection
          name = data.collection
          id = data.id
          item =
            "_id": id

          _.each data.fields, (value, key) -> item[key] = value if data.fields

          @cache[name].upsert(item)

      # subscriptions ready
      when "ready"
        _.each data.subs, (id) =>
          cb = @_callbacks[id]
          if (cb)
            cb()
            delete @_callbacks[id]

      # minimal heartbeat response for ddp pre2
      when "ping"
        msg = msg: "pong"
        msg.id = data.id if _.has(data, "id")
        @_send msg

  _getNextId: -> (@_nextId += 1).toString()

  ###
  # open the connection to the server
  #
  #  connected(): Called when the 'connected' message is received
  #               If autoReconnect is true (default), the callback will be
  #               called each time the connection is opened.
  #
  ###
  connect: (connected) ->
    @_isConnecting = true
    @_connectionFailed = false
    @_isClosing = false

    if connected
      @addListener "connected", =>
        @_clearReconnectTimeout()

        connected(undefined, @_isReconnecting)
        @_isConnecting = false
        @_isReconnecting = false

      @addListener "failed", (error) =>
        @_isConnecting = false
        @_connectionFailed = true
        connected(error, @_isReconnecting)

    url = @_buildWsUrl()
    @_makeWebSocketConnection(url)

  _endPendingMethodCalls: ->
    ids = _.keys(self._pendingMethods)
    @_pendingMethods = {}

    ids.forEach (id) =>
      if @_callbacks[id]
        @_callbacks[id](new Error("DDPClient: Disconnected from DDP server"))
        delete @_callbacks[id]

      if @_updatedCallbacks[id]
        @_updatedCallbacks[id]()
        delete @_updatedCallbacks[id]

  _buildWsUrl: (path) ->
    path = path ? @path ? "websocket"
    protocol = if @ssl then "wss://" else "ws://"

    if @url
      url = @url
    else
      url = protocol + @host + ":" + @port
      url += if (path.indexOf("/") is 0) then path else "/" + path
    url

  _makeWebSocketConnection: (url) ->
    @socket = new @socketConstructor(url)
    @_prepareHandlers()

  close: ->
    @_isClosing = true
    @socket.close()
    @removeAllListeners("connected")
    @removeAllListeners("failed")


  ###
  # call a method on the server,
  #
  # callback = function(err, result)
  ###
  call: (name, params, callback, updatedCallback) ->
    id = @_getNextId()

    @_callbacks[id] = ->
      delete @_pendingMethods[id]
      callback.apply(this, arguments) if callback

    @_updatedCallbacks[id] = ->
      delete @_pendingMethods[id]
      updatedCallback.apply(this, arguments) if updatedCallback

    @_pendingMethods[id] = true

    @_send(
      msg: "method"
      id: id
      method: name
      params: params
    )


  callWithRandomSeed: (name, params, randomSeed, callback, updatedCallback) ->
    id = self._getNextId()

    self._callbacks[id] = callback if callback

    self._updatedCallbacks[id] = updatedCallback if updatedCallback

    self._send(
      msg: "method"
      id: id
      method: name
      randomSeed: randomSeed
      params: params
    )

  # open a subscription on the server, callback should handle on ready and nosub
  subscribe: (name, params, callback) ->
    id = @_getNextId()
    @_callbacks[id] = callback if (callback)

    @_send(
      msg: "sub"
      id: id
      name: name
      params: params
    )

    id


  unsubscribe: (id) ->
    _send(
      msg: "unsub"
      id: id
    )


module.exports = DDPClient
