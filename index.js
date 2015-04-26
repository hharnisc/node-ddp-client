"use strict";

var _ = require('underscore');
var EventEmitter = require('events').EventEmitter;
var EJSON = require("ejson");

class DDPClient extends EventEmitter{
  constructor(opts) {
    opts = opts || {};

    // backwards compatibility
    if ("use_ssl" in opts)
      opts.ssl = opts.use_ssl;
    if ("auto_reconnect" in opts)
      opts.autoReconnect = opts.auto_reconnect;
    if ("auto_reconnect_timer" in opts)
      opts.autoReconnectTimer = opts.auto_reconnect_timer;
    if ("maintain_collections" in opts)
      opts.maintainCollections = opts.maintain_collections;
    if ("ddp_version" in opts)
      opts.ddpVersion = opts.ddp_version;

    // default arguments
    this.host = opts.host || "localhost";
    this.port = opts.port || 3000;
    this.path = opts.path;
    this.ssl = opts.ssl || this.port === 443;
    this.tlsOpts = opts.tlsOpts || {};
    this.autoReconnect = ("autoReconnect" in opts) ? opts.autoReconnect : true;
    this.autoReconnectTimer = ("autoReconnectTimer" in opts) ? opts.autoReconnectTimer : 500;
    this.maintainCollections = ("maintainCollections" in opts) ? opts.maintainCollections : true;
    this.url = opts.url;
    this.socketConstructor = opts.socketContructor || WebSocket;

    // support multiple ddp versions
    this.ddpVersion = ("ddpVersion" in opts) ? opts.ddpVersion : "1";
    this.supportedDdpVersions = ["1", "pre2", "pre1"];

    // Expose EJSON object, so client can use EJSON.addType(...)
    this.EJSON = EJSON;

    // very very simple collections (name -> [{id -> document}])
    if (this.maintainCollections) {
      this.collections = {};
    }

    // internal stuff to track callbacks
    this._isConnecting = false;
    this._isReconnecting = false;
    this._nextId = 0;
    this._callbacks = {};
    this._updatedCallbacks = {};
    this._pendingMethods = {};
    this._observers = {};
  }

  _prepareHandlers() {

    this.socket.on("open", function() {
      // just go ahead and open the connection on connect
      this._send({
        msg : "connect",
        version : this.ddpVersion,
        support : this.supportedDdpVersions
      });
    });

    this.socket.on("error", function(error) {
      // error received before connection was established
      if (this._isConnecting) {
        this.emit("failed", error.message);
      }

      this.emit("socket-error", error);
    });

    this.socket.on("close", function(event) {
      this.emit("socket-close", event.code, event.reason);
      this._endPendingMethodCalls();
      this._recoverNetworkError();
    });

    this.socket.on("message", function(event) {
      this._message(event.data);
      this.emit("message", event.data);
    });
  }

  _clearReconnectTimeout() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  _recoverNetworkError() {
    if (this.autoReconnect && ! this._connectionFailed && ! this._isClosing) {
      this._clearReconnectTimeout();
      this.reconnectTimeout = setTimeout(function() { this.connect(); }, this.autoReconnectTimer);
      this._isReconnecting = true;
    }
  }

  ///////////////////////////////////////////////////////////////////////////
  // RAW, low level functions
  _send(data) {
    this.socket.send(
      EJSON.stringify(data)
    );
  }

  // handle a message from the server
  _message(data) {

    data = EJSON.parse(data);

    // TODO: 'addedBefore' -- not yet implemented in Meteor
    // TODO: 'movedBefore' -- not yet implemented in Meteor

    if (!data.msg) {
      return;

    } else if (data.msg === "failed") {
      if (this.supportedDdpVersions.indexOf(data.version) !== -1) {
        this.ddpVersion = data.version;
        this.connect();
      } else {
        this.autoReconnect = false;
        this.emit("failed", "Cannot negotiate DDP version");
      }

    } else if (data.msg === "connected") {
      this.session = data.session;
      this.emit("connected");

    // method result
    } else if (data.msg === "result") {
      var cb = this._callbacks[data.id];

      if (cb) {
        cb(data.error, data.result);
        delete this._callbacks[data.id];
      }

    // method updated
    } else if (data.msg === "updated") {

      _.each(data.methods, function (method) {
        var cb = this._updatedCallbacks[method];
        if (cb) {
          cb();
          delete this._updatedCallbacks[method];
        }
      });

    // missing subscription
    } else if (data.msg === "nosub") {
      var cb = this._callbacks[data.id];

      if (cb) {
        cb(data.error);
        delete this._callbacks[data.id];
      }

    // add document to collection
    } else if (data.msg === "added") {
      if (this.maintainCollections && data.collection) {
        var name = data.collection, id = data.id;

        if (! this.collections[name])     { this.collections[name] = {}; }
        if (! this.collections[name][id]) { this.collections[name][id] = {}; }

        this.collections[name][id]._id = id;

        if (data.fields) {
          _.each(data.fields, function(value, key) {
            this.collections[name][id][key] = value;
          });
        }

        if (this._observers[name]) {
          _.each(this._observers[name], function(observer) {
            observer.added(id);
          });
        }
      }

    // remove document from collection
    } else if (data.msg === "removed") {
      if (this.maintainCollections && data.collection) {
        var name = data.collection, id = data.id;

        if (! this.collections[name][id]) {
          return;
        }

        var oldValue = this.collections[name][id];

        delete this.collections[name][id];

        if (this._observers[name]) {
          _.each(this._observers[name], function(observer) {
            observer.removed(id, oldValue);
          });
        }
      }

    // change document in collection
    } else if (data.msg === "changed") {
      if (this.maintainCollections && data.collection) {
        var name = data.collection, id = data.id;

        if (! this.collections[name])     { return; }
        if (! this.collections[name][id]) { return; }

        var oldFields     = {},
            clearedFields = data.cleared || [],
            newFields = {};

        if (data.fields) {
          _.each(data.fields, function(value, key) {
              oldFields[key] = this.collections[name][id][key];
              newFields[key] = value;
              this.collections[name][id][key] = value;
          });
        }

        if (data.cleared) {
          _.each(data.cleared, function(value) {
              delete this.collections[name][id][value];
          });
        }

        if (this._observers[name]) {
          _.each(this._observers[name], function(observer) {
            observer.changed(id, oldFields, clearedFields, newFields);
          });
        }
      }

    // subscriptions ready
    } else if (data.msg === "ready") {
      _.each(data.subs, function(id) {
        var cb = this._callbacks[id];
        if (cb) {
          cb();
          delete this._callbacks[id];
        }
      });

    // minimal heartbeat response for ddp pre2
    } else if (data.msg === "ping") {
      this._send(
        _.has(data, "id") ? { msg : "pong", id : data.id } : { msg : "pong" }
      );
    }
  }


  _getNextId() {
    return (this._nextId += 1).toString();
  }


  _addObserver(observer) {
    if (! this._observers[observer.name]) {
      this._observers[observer.name] = {};
    }
    this._observers[observer.name][observer._id] = observer;
  }


  _removeObserver(observer) {
    if (! this._observers[observer.name]) { return; }

    delete this._observers[observer.name][observer._id];
  }

  //////////////////////////////////////////////////////////////////////////
  // USER functions -- use these to control the client

  /* open the connection to the server
   *
   *  connected(): Called when the 'connected' message is received
   *               If autoReconnect is true (default), the callback will be
   *               called each time the connection is opened.
   */
  connect(connected) {
    this._isConnecting = true;
    this._connectionFailed = false;
    this._isClosing = false;

    if (connected) {
      this.addListener("connected", function() {
        this._clearReconnectTimeout();

        connected(undefined, this._isReconnecting);
        this._isConnecting = false;
        this._isReconnecting = false;
      });
      this.addListener("failed", function(error) {
        this._isConnecting = false;
        this._connectionFailed = true;
        connected(error, this._isReconnecting);
      });
    }

    var url = this._buildWsUrl();
    this._makeWebSocketConnection(url);

  }

  _endPendingMethodCalls() {
    var ids = _.keys(this._pendingMethods);
    this._pendingMethods = {};

    ids.forEach(function (id) {
      if (this._callbacks[id]) {
        this._callbacks[id](new Error("DDPClient: Disconnected from DDP server"));
        delete this._callbacks[id];
      }

      if (this._updatedCallbacks[id]) {
        this._updatedCallbacks[id]();
        delete this._updatedCallbacks[id];
      }
    });
  }

  _buildWsUrl(path) {
    var url;
    path = path || this.path || "websocket";
    var protocol = this.ssl ? "wss://" : "ws://";
    if (this.url) {
      url = this.url;
    } else {
      url = protocol + this.host + ":" + this.port;
      url += (path.indexOf("/") === 0)? path : "/" + path;
    }
    return url;
  }

  _makeWebSocketConnection(url) {
    this.socket = new this.socketConstructor(url);
    this._prepareHandlers();
  }

  close() {
    this._isClosing = true;
    this.socket.close();
    this.removeAllListeners("connected");
    this.removeAllListeners("failed");
  }


  // call a method on the server,
  //
  // callback = function(err, result)
  call(name, params, callback, updatedCallback) {
    var id = this._getNextId();

    this._callbacks[id] = function () {
      delete this._pendingMethods[id];

      if (callback) {
        callback.apply(this, arguments);
      }
    };

    this._updatedCallbacks[id] = function () {
      delete this._pendingMethods[id];

      if (updatedCallback) {
        updatedCallback.apply(this, arguments);
      }
    };

    this._pendingMethods[id] = true;

    this._send({
      msg    : "method",
      id     : id,
      method : name,
      params : params
    });
  }


  callWithRandomSeed(name, params, randomSeed, callback, updatedCallback) {
    var id = this._getNextId();

    if (callback) {
      this._callbacks[id] = callback;
    }

    if (updatedCallback) {
      this._updatedCallbacks[id] = updatedCallback;
    }

    this._send({
      msg        : "method",
      id         : id,
      method     : name,
      randomSeed : randomSeed,
      params     : params
    });
  }

  // open a subscription on the server, callback should handle on ready and nosub
  subscribe(name, params, callback) {
    var id = this._getNextId();

    if (callback) {
      this._callbacks[id] = callback;
    }

    this._send({
      msg    : "sub",
      id     : id,
      name   : name,
      params : params
    });

    return id;
  }

  unsubscribe(id) {

    this._send({
      msg : "unsub",
      id  : id
    });
  }

  /**
   * Adds an observer to a collection and returns the observer.
   * Observation can be stopped by calling the stop() method on the observer.
   * Functions for added, updated and removed can be added to the observer
   * afterward.
   */
  observe(name, added, updated, removed) {
    var observer = {};
    var id = this._getNextId();

    // name, _id are immutable
    Object.defineProperty(observer, "name", {
      get: function() { return name; },
      enumerable: true
    });

    Object.defineProperty(observer, "_id", { get: function() { return id; }});

    observer.added   = added   || function(){};
    observer.updated = updated || function(){};
    observer.removed = removed || function(){};

    observer.stop = function() {
      this._removeObserver(observer);
    };

    this._addObserver(observer);

    return observer;
  }

}
