"use strict";

const redis = require("redis"),
  _ = require("underscore"),
  LOG = require("./logger").createLogger();

function asyncNext(array, index, cb) {
  return (index >= array.length) ?
    Promise.resolve() :
    cb(array[index]).then(
      ()=> asyncNext(array, index + 1, cb));
}

class Client {
  /**
   * @constructor
   * @param  {Object} api         api from "/lib/api.js"
   * @param  {Object} connection  configuration for redis connection
   */
  constructor(api, connection) {
    this.client = Client.getClient(connection);
    this.clientPubSub = Client.getClient(connection);
    this.api = api;
    this.isPublisher = false;
    this.id = null;
  }

  /**
   * Message generator
   * @return {Number} message
   */
  getMessage() {
    this.cnt = this.cnt || 0;
    return this.cnt++;
  }

  /**
   * Start client
   * @param cfg   additional config
   * @return {Promise}
   */
  start(cfg) {
    LOG.info("start");
    if (!this.client) {
      throw new Error("needs initialize this.client");
    }
    if (!this.clientPubSub) {
      throw new Error("needs initialize this.clientPubSub");
    }

    const options = _.defaults(cfg, {
      tagPublish: "CHANNEL",
      tagSubscribers: "SUBSCRIBERS",
      channelSubscribers: "channel:SUBSCRIBERS",
      fnReceivedSubs: null,
      subscribers: [],                            // list of SUBSCRIBERS
      failsLimit: 2,                              // fail limit for subsriber
      publishTimeout: 500
    });

    this.clientPubSub.on("message", (channel, msg)=> {
      if (this.isPublisher) {
        if (channel === options.channelSubscribers) {
          options.subscribers.push(msg);
          options.fnReceivedSubs && options.fnReceivedSubs(msg);
          LOG.info(`new subscribers:` + options.subscribers.join(", "));
        }
      } else {
        const channelMsg = Client.channelPattern(this.id, options.tagPublish);
        if (channel === channelMsg) {
          this.eventHandler(msg, (err, msg)=> {
            if (err) {
              this.api.asyncPushError(this.client, msg);
            } else {
              LOG.log("" + this.id + ":" + msg);
            }
          });
          this.runSubscriber(2000);
        }
      }
    });

    return this.api.asyncGetId(this.client)
      .then((id)=> this.id = id)
      .then(()=> this.api.asyncAcquirePublisher(this.client, this.id))
      .then((isPublisher)=> {
        this.isPublisher = isPublisher;
        return isPublisher ?
          this.startPublisher(options) :
          this.startSubscriber(options);
      })
      .catch((err)=> {
        this.stopCheck();
        LOG.error(err);
        this.client.end();
        this.client = null;
      });
  }

  /**
   * Start client flow in publisher mode
   * @private
   * @param  {Object}  config   client configuration
   * @return {Promise}          App flow promise
   */
  startPublisher(config) {
    LOG.info("startPublisher");
    if (!this.client) {
      throw new Error("needs initialize this.client");
    }

    // get remove list of subribers and cache it
    return this.api.asyncGetSubscribers(this.client, config.tagSubscribers)
      .then((subs)=> {
        config.subscribers = config.subscribers.concat(subs);

        LOG.debug(`startPublisher:: clientPubSub.subscribe ${config.channelSubscribers}`);
        this.clientPubSub.subscribe(config.channelSubscribers);
        this.startCheck((isPublisher)=> {
          // is client isn't publisher stop
          // and run in subscriber mode
          if (!isPublisher) {
            LOG.debug(`startPublisher:: client.unsubscribe ${config.channelSubscribers}`);
            this.clientPubSub.unsubscribe(config.channelSubscribers);
            this.stopCheck();
          }
        });
        /* eslint no-use-before-define: 0*/
        return this.runPublisher(config);
      });
  }

  /**
   * Start client flow in subscriber mode
   * @private
   * @param  {Object}  config   client configuration
   * @return {Promise}          App flow promise
   */
  startSubscriber(config) {
    LOG.info("startSubscriber");
    if (!this.client) {
      throw new Error("needs initialize this.client");
    }
    return new Promise((becomePublisher)=> {
      const channelReceiveMsg = Client.channelPattern(this.id, config.tagPublish);

      this.setSwitchToPublisher(()=> {
        this.clientPubSub.unsubscribe(channelReceiveMsg);
        becomePublisher();
      });

      // subscribe message receiving from publisher
      this.clientPubSub.subscribe(channelReceiveMsg);

      // register client as subscriber in system
      this.api.asyncSubscribe(this.client, this.id)
        .then(()=> this.runSubscriber());
    }).then(()=> this.startPublisher(config));
  }

  /**
   * presave callback to switch to publisher mode, see switchToPublisher
   * @private
   * @param {Function} fn callback to switch to publisher mode
   */
  setSwitchToPublisher(fn) {
    LOG.debug("setSwitchToPublisher");
    this._becamePublisher = fn;
  }

  /**
   * Switch to publisher mode if callback has setted with setSwitchToPublisher
   * @private
   */
  switchToPublisher() {
    LOG.debug("switchToPublisher");
    this._becamePublisher && this._becamePublisher();
  }

  /**
   * if message wouldn't receive from publisher after _timeout try to change mode
   * @private
   * @param  {Number} 2000 by default _timeout timeout after try to change mode
   */
  runSubscriber(_timeout) {
    LOG.debug("runSubscriber");
    const timeout = _timeout || 2000;
    if (this._handleSubscriberAwait) {
      clearTimeout(this._handleSubscriberAwait);
    }
    this._handleSubscriberAwait = setTimeout(()=> {
      this._handleSubscriberAwait = null;
      this.handleCheck((isPublisher)=> isPublisher ?
        this.switchToPublisher() :
        this.runSubscriber(timeout));
    }, timeout);
  }

  /**
   * start to sending messages for subsribers
   * @private
   * @param  {Object}         config        client configuration
   * @param  {Array<String>}  _repeatMsg    messages which wasn't received by any subscriber
   * @param  {Obhect}         _incativeSubs inactive subscribers
   * @return {Promise}                      App flow promise
   */
  runPublisher(config, _repeatMsg, _incativeSubs) {
    LOG.debug("runPublisher");
    if (!this.isPublisher) {
      // now switch to subscriber mode
      return this.startSubscriber(config);
    }
    const repeatMsg = _repeatMsg || [];
    const failsLimit = config.failsLimit || 2;
    const remoteRemove = [];

    // check which subscribers needs remove
    const incativeSubs = _.reduce(_incativeSubs, (memo, fails, id)=> {
      if (fails > failsLimit) {
        remoteRemove.push(id);
      } else {
        memo[id] = fails;
      }
      return memo;
    }, {});

    // remove remote and local subscribers
    if (remoteRemove.length) {
      LOG.info("remove: " + remoteRemove.join(", "));
      this.api.asyncRemoveSubscribers(this.client, remoteRemove)
        .then(()=> {
          LOG.info("after remove: " + config.subscribers.join(", "));
        });
      config.subscribers = _.filter(config.subscribers, (id)=> remoteRemove.indexOf(id) < 0);
    }

    // if there aren't any subsribers await them
    if (!config.subscribers.length) {
      LOG.debug("runPublisher:: awaiting subscribers");
      return new Promise((resolve)=> {
        config.fnReceivedSubs = resolve;
      }).then(()=> {
        LOG.debug("runPublisher:: rerun publisher");
        return this.runPublisher(config, repeatMsg, incativeSubs);
      });
    } else {
      LOG.debug("runPublisher:: start publishing");
    }

    // publish messages
    return asyncNext(config.subscribers, 0, (id)=> {
      const channel = Client.channelPattern(id, config.tagPublish);

      // get not sending messages or generate new
      const msg = (repeatMsg && repeatMsg.lenght) ?
        repeatMsg.pop() : this.getMessage();

      // send message
      const asyncPublish = this.api.asyncPublishMessage(this.client, channel, msg);

      asyncPublish.then((received)=> {
        // message hasn't been delivered
        /* eslint eqeqeq: 0 */
        if (received == 0) {
          incativeSubs[id] || (incativeSubs[id] = 0);
          incativeSubs[id] += 1;
          repeatMsg.push(msg);
        } else if (received > 1) { /* incorrect situation */
          LOG.warn(`${received} clients receive messages`);
        }
      });
      return asyncPublish.then(()=> new Promise((resolve)=> {
        setTimeout(resolve, config.publishTimeout || 500);
      }));
    })
    .then(()=> this.runPublisher(config, repeatMsg, incativeSubs));
  }
  /**
   * Helper method for checking avalability of publisher lock
   * @private
   * @param  {Function} cb Callback called after checking
   * @return {Promise<IsPublisher>}
   */
  handleCheck(cb) {
    return this.api.asyncCheckPublisher(this.client, this.id)
      .then(
        (isPublisher)=> {
          this.isPublisher = isPublisher;
          cb && cb(isPublisher);
        },
        (err)=> LOG.warn(`start -> asyncCheckPublisher error ${err}`));
  }
  /**
   * Start check interval
   * @param  {Function} cb      Callback called after checking
   * @param  {Number}   timeout Interval timeout
   */
  startCheck(cb, timeout) {
    this._handleCheck = setInterval(
      ()=> this.handleCheck(cb), timeout || 5000);
  }

  /**
   * Stop cheking interval
   * @private
   */
  stopCheck() {
    clearInterval(this._handleCheck);
    this._handleCheck = null;
  }
  /**
   * [eventHandler description]
   * @param  {String}   msg      message
   * @param  {Function} callback callback
   */
  eventHandler(msg, callback) {
    function onComplete() {
      const error = Math.random() > 0.85;
      callback(error, msg);
    }
    setTimeout(onComplete, Math.floor(Math.random() * 1000));
  }
}

/**
 * Pattern for channel "<tag>.<id>"
 * @param  {Number|String}  id
 * @param  {String} tag     tag
 * @return {String}         patter
 */
Client.channelPattern = function(id, tag) {
  return `${tag || "CHANNEL"}.${id}`;
};

/**
 * get redis client connection
 * @param  {Object} connection connection params
 * @return {RedisClient}       redis client
 */
Client.getClient = function(connection) {
  const options = _.extend({detect_buffers: true}, connection);
  return redis.createClient(options);
};

/**
 * Read all errors from subsribers
 * @param  {Object} api         api from "/lib/api.js"
 * @param  {Object} connection  configuration for redis connection
 */
Client.readErrors = function(api, connection) {
  const client = Client.getClient(connection);
  api.asyncPopErrors(client)
    .then((data)=> {
      if (!data) {
        LOG.log("Try again errors container lock");
      } else {
        LOG.log(data.length ? data.join(", ") : "No errors");
      }
      client.end();
    })
    .catch(()=> client.end());
};

module.exports = Client;
