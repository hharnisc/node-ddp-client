"use strict";

let DDPClient = require('./index.js');

class DDP extends DDPClient {
  constructor(opts) {
    super(opts);
  }

  connect() {
    return new Promise((resolve, reject) => {
      super.connect((err, wasReconnect) => {
        if (err) {
          console.log('DDP connection error!');
          return reject(err);
        }

        if (wasReconnect) {
          console.log('Reestablishment of a connection.');
        }

        console.log('connected to Meteor server');
        resolve(this._isReconnecting);
      });
    });
  }

  call(name, params) {
    return new Promise((resolve, reject) => {
      super.call(name, params, (err, res) => {
        if (err) {
          reject(err);
        } else { 
          resolve(res);
        }
      }, () => {
        // callback which fires when server has finished
      });
    });
  }

  callWithRandomSeed(name, params, randomSeed) {
    return new Promise((resolve, reject) => {
      super.callWithRandomSeed(name, params, randomSeed, (err, res) => {
        if (err) { r
          reject(err);
        } else { 
          resolve(res);
        }
      }, () => {
        // callback which fires when server has finished
      });
    });
  }

  subscribe(...args) {
    return super.subscribe(...args);
  }

  unsubscribe(...args) {
    return super.unsubscribe(...args);
  }

  close() {
    return super.close();
  }

  observe(...args) {
    return super.observe(...args);
  }
}

module.exports = DDP;
