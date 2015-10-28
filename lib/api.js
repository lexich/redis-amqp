"use strict";
const _ = require("underscore");
const CLIENT_NOT_EXIST = "client instance doesn't exist";
const LOG = require("./logger").createLogger();

/**
 * get client id from system
 * @param  {Redis.Client}   client redis client instance
 * @param  {String}         _idTag Field where client id registered @default "IDTAG"
 * @return {Promise<ID>}    client ID
 */
function asyncGetId(client, _idTag) {
  LOG.debug("asyncGetId");
  const idTag = _idTag || "IDTAG";
  if (!client) {
    throw new Error(CLIENT_NOT_EXIST);
  }
  return new Promise((resolve, reject)=> {
    client.incr(idTag, (err, id)=>  err ? reject(err) : resolve(id));
  });
}

/**
 * ascuire lock for publish otherwise client is subscriber
 * @param  {Redis.Client}    client redis client instance
 * @param  {Number} id       client id
 * @param  {String} _lockTag name of lock tag @default "SERVERLOCK"
 * @param  {Number} _expire  expire time for ascuire lock
 * @return {Promise<Number>} 1 - client publisher 0 - subscriber
 */
function asyncAcquirePublisher(client, id, _lockTag, _expire) {
  LOG.debug("asyncAcquirePublisher");
  if (!client) {
    throw new Error(CLIENT_NOT_EXIST);
  }
  if (!id) {
    throw new Error("argument id doesn't exist");
  }
  const lockTag = _lockTag || "SERVERLOCK";
  const expire = _expire || 10;
  return new Promise((resolve, reject)=> {
    client.setnx(lockTag, id, (err, result)=> {
      err ? reject(err) : resolve(result);
    });
  }).then((isAcquire)=> {
    if (!isAcquire) { return isAcquire; }
    return new Promise((resolve, reject)=> {
      client.expire(lockTag, expire, (err, result)=> {
        if (err) { return reject(err); }
        if (!result) { return reject(`Lock key ${lockTag} doesn't exist`); }
        return resolve(isAcquire);
      });
    });
  });
}

/**
 * check publisher mode avalability
 * @param  {Redis.Client}    client redis client instance
 * @param  {Number} id       client id
 * @param  {String} _lockTag name of lock tag @default "SERVERLOCK"
 * @param  {Number} _expire  expire time for ascuire lock
 * @return {Promise<Number>} 1 - client publisher 0 - subscriber
 */
function asyncCheckPublisher(client, id, _lockTag, _expire) {
  LOG.debug(`asyncCheckPublisher`);
  if (!client) {
    throw new Error(CLIENT_NOT_EXIST);
  }
  if (!id) {
    throw new Error("argument id doesn't exist");
  }
  const lockTag = _lockTag || "SERVERLOCK";
  const expire = _expire || 10;
  LOG.debug(`asyncCheckPublisher id:${id} lockTag:${lockTag} expire:${expire}`);
  return new Promise((resolve, reject)=> {
    client.get(lockTag, (err, lockID)=> {
      err ? reject(err) : resolve(lockID);
    });
  })
  .then((lockID)=> {
    /* eslint eqeqeq: 0 */
    if (!lockID) {
      LOG.debug("asyncCheckPublisher:: lock is free");
      return asyncAcquirePublisher(client, id, lockTag, expire);
    } else if (lockID == id) {
      LOG.debug("asyncCheckPublisher:: to long expire");
      return new Promise((resolve, reject)=> {
        client.expire(lockTag, expire,
          (err, result)=> err ? reject(err) : resolve(result));
      });
    } else {
      LOG.debug(`asyncCheckPublisher:: you are subscriber:${id} publisher:${lockID}`);
      return 0;
    }
  });
}

/**
 * publish message to channel
 * @param  {Redis.Client}    client redis client instance
 * @param  {String} channel  channel name
 * @param  {String} message  sending message
 * @return {Promise<Number>} number of clients has received messages
 */
function asyncPublishMessage(client, channel, message) {
  LOG.debug("asyncPublishMessage");
  if (!client) {
    throw new Error(CLIENT_NOT_EXIST);
  }
  if (!channel) {
    throw new Error("argument channel doesn't exist");
  }
  return new Promise((resolve, reject)=> {
    client.publish(channel, message || "", (err, received)=> {
      err ? reject(err) : resolve(received);
    });
  });
}

/**
 * get list of subsribers
 * @param  {Redis.Client}           client redis client instance
 * @param  {String} _tagSubscribers name of tag
 * @return {Promise<Array>}         list of subscribers
 */
function asyncGetSubscribers(client, _tagSubscribers) {
  if (!client) {
    throw new Error(CLIENT_NOT_EXIST);
  }
  const tagSubscribers = _tagSubscribers || "SUBSCRIBERS";
  LOG.debug("asyncGetSubscribers", tagSubscribers);
  return new Promise((resolve, reject)=> {
    client.lrange(tagSubscribers, 0, -1, (err, result)=> {
      err ? reject(err) : resolve(result);
    });
  });
}

/**
 * [asyncRemoveSubscribers description]
 * @param  {Redis.Client}           client redis client instance
 * @param  {Array|Number} subs      removing subsribers
 * @param  {String} _tagSubscribers name of tag
 * @return {Promise<Array>}         list of subscribers
 */
function asyncRemoveSubscribers(client, subs, _tagSubscribers) {
  LOG.debug("asyncRemoveSubscribers");
  if (!client) {
    throw new Error(CLIENT_NOT_EXIST);
  }
  const tagSubscribers = _tagSubscribers || "SUBSCRIBERS";
  const buffer = _.isArray(subs) ? subs : [subs];
  const awaiting = _.chain(buffer).uniq().map(
    (item)=> new Promise((resolve, reject)=> {
      client.lrem(tagSubscribers, 0, item, (err)=> {
        err ? reject(err) : resolve();
      });
    })).value();

  return Promise
    .all(awaiting)
    .then(()=> asyncGetSubscribers(client, tagSubscribers));
}

/**
 * register as client
 * @param  {Redis.Client}           client redis client instance
 * @param  {Number} id              client id
 * @param  {String} _tagSubscribers name of tag
 * @return {Promise}
 */
function asyncSubscribe(client, id, _tagSubscribers, _channel) {
  LOG.debug("asyncSubscribe");
  if (!client) {
    throw new Error(CLIENT_NOT_EXIST);
  }
  if (!id) {
    throw new Error("argument id doesn't exist");
  }
  const tagSubscribers = _tagSubscribers || "SUBSCRIBERS";
  const channel = _channel || `channel:${tagSubscribers}`;
  return new Promise((resolve, reject)=> {
    client.rpush(tagSubscribers, id,
      (err, index)=> err ? reject(err) : resolve(index));
  }).then(()=> new Promise((resolve, reject)=> {
    client.publish(channel, id, (err)=> err ? reject(err) : resolve(id));
  }));
}

/**
 * dirsturbed mutex
 * @param  {Redis.Client}           client redis client instance
 * @param  {String}   tagSync       tag for mutex sync
 * @param  {Function} cb            callback with you logic must call first argument
 *                                  for release mutex
 * @return {Promise<Data>}          you data
 */
function asyncMutex(client, tagSync, cb) {
  LOG.debug("asyncMutex");
  if (!client) {
    throw new Error(CLIENT_NOT_EXIST);
  }
  if (!tagSync) {
    throw new Error("argument tag doesn't exist");
  }
  if (!cb) {
    throw new Error("argument cb doesn't exist");
  }

  function asyncFree() {
    LOG.debug("asyncMutex::asyncFree");
    return new Promise((resolve, reject)=> {
      client.del(tagSync, (err, data)=> err ? reject(err) : resolve(data));
    });
  }
  return new Promise((resolve, reject)=> {
    client.setnx(tagSync, 1, (err, result)=> err ? reject(err) : resolve(result));
  })
  .then((isAcq)=> !isAcq ? asyncFree() : cb(asyncFree));
}

/**
 * [asyncPushError description]
 * @param  {Redis.Client}     client redis client instance
 * @param  {String} msg       error message
 * @param  {String} _tagError tag for error message
 * @return {Promise}
 */
function asyncPushError(client, msg, _tagError) {
  LOG.debug("asyncPushError");
  if (!client) {
    throw new Error(CLIENT_NOT_EXIST);
  }
  const tagError = _tagError || "ERRORS";
  return new Promise((resolve, reject)=> {
    client.rpush(tagError, msg, (err, result)=> err ? reject(err) : resolve(result));
  });
}

/**
 * [asyncPopErrors description]
 * @param  {Redis.Client}     client redis client instance
 * @param  {String} _tagError tag for error message
 * @return {Promise}
 */
function asyncPopErrors(client, _tagError) {
  LOG.debug("asyncPopErrors");
  if (!client) {
    throw new Error(CLIENT_NOT_EXIST);
  }
  const tagError = _tagError || "ERRORS";
  const tagSync = `${tagError}_sync`;
  return asyncMutex(client, tagSync, (freeMutext)=> {
    return new Promise((resolve, reject)=> {
      client.lrange(tagError, 0, -1, (err, result)=> err ? reject(err) : resolve(result));
    })
    .then((data)=> {
      return new Promise((resolve, reject)=> {
        const index = _.size(data);
        client.ltrim(tagError, index, -1, (err, result)=> err ? reject(err) : resolve(result));
      })
      .then(freeMutext)
      .then(()=> data);
    });
  });
}

module.exports = {
  CLIENT_NOT_EXIST,
  asyncGetId,
  asyncAcquirePublisher,
  asyncCheckPublisher,
  asyncGetSubscribers,
  asyncRemoveSubscribers,
  asyncSubscribe,
  asyncPublishMessage,
  asyncMutex,
  asyncPushError,
  asyncPopErrors
};
