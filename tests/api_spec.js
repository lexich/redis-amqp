"use strict";
/* global describe, it */

const api = require("../lib/api");
const expect = require("chai").expect;
const LOG = require("../lib/logger");

LOG.setLevel("error");

describe("test redis api", ()=> {
  describe("asyncGetId", ()=> {
    it("check null args", ()=> {
      expect(api.asyncGetId).to.throw(Error, api.CLIENT_NOT_EXIST);
    });
    it("check default idTag", ()=> {
      const client = {
        incr(idTag, cb) {
          this.idTag = idTag;
          cb(null, "OK");
        }
      };
      return api.asyncGetId(client).then((result)=> {
        expect(result).to.eql("OK");
        expect(client.idTag).to.eql("IDTAG");
      });
    });
    it("check custom tag", ()=> {
      const client = {
        incr(idTag, cb) {
          this.idTag = idTag;
          cb("error");
        }
      };
      return api.asyncGetId(client, "CUSTOM")
        .then(()=> expect(true, "Fail branch").to.be.false)
        .catch((err)=> {
          expect(err).to.eql("error");
          expect(client.idTag).to.eql("CUSTOM");
        });
    });
  });
  describe("asyncAcquirePublisher", ()=> {
    it("check null args", ()=> {
      expect(api.asyncAcquirePublisher).to.throw(Error, api.CLIENT_NOT_EXIST);
      const failId = ()=> api.asyncAcquirePublisher({});
      expect(failId).to.throw(Error, "argument id doesn't exist");
    });
    it("check default args with acquire", ()=> {
      const client = {
        setnx(key, id, cb) {
          this.key = key;
          this.id = id;
          cb(null, 1);
        },
        expire(key, expire, cb) {
          this.key1 = key;
          this.expire = expire;
          cb(null, 1);
        }
      };
      return api.asyncAcquirePublisher(client, 1)
        .then((isAcquire)=> {
          expect(isAcquire).to.eql(1);
          expect(client.id).to.eql(1);
          expect(client.key).to.eql("SERVERLOCK");
          expect(client.key1).to.eql("SERVERLOCK");
          expect(client.expire).to.eql(10);
        });
    });
    it("check default args without acquire", ()=> {
      const client = {
        setnx(key, id, cb) {
          this.key = key;
          this.id = id;
          cb(null, 0);
        },
        expire(key, expire, cb) {
          cb("Fail branch");
        }
      };
      return api.asyncAcquirePublisher(client, 1, "TEST")
        .then((isAcquire)=> {
          expect(isAcquire).to.eql(0);
          expect(client.id).to.eql(1);
          expect(client.key).to.eql("TEST");
        });
    });
  });
  describe("asyncPublishMessage", ()=> {
    it("check null args", ()=> {
      expect(api.asyncPublishMessage).to.throw(Error, api.CLIENT_NOT_EXIST);
      const failChannel = ()=> api.asyncPublishMessage({});
      expect(failChannel).to.throw(Error, "argument channel doesn't exist");
    });
    it("check publish", ()=> {
      const client = {
        publish(channel, message, cb) {
          this.channel = channel;
          this.message = message;
          cb(null, 1);
        }
      };
      return api.asyncPublishMessage(client, "TEST", "Hey")
        .then((msg)=> {
          expect(msg).to.eql(1);
          expect(client.channel).to.eql("TEST");
          expect(client.message).to.eql("Hey");
        });
    });
  });
  describe("asyncGetSubscribers", ()=> {
    it("check null args", ()=> {
      expect(api.asyncGetSubscribers).to.throw(Error, api.CLIENT_NOT_EXIST);
    });
    it("check lrange", ()=> {
      const client = {
        lrange(tag, start, end, cb) {
          this.tag = tag;
          this.start = start;
          this.end = end;
          cb(null, [1]);
        }
      };
      return api.asyncGetSubscribers(client)
        .then((range)=> {
          expect(range).to.eql([1]);
          expect(client.tag).to.eql("SUBSCRIBERS");
          expect(client.start).to.eql(0);
          expect(client.end).to.eql(-1);
        });
    });
  });
  describe("asyncRemoveSubscribers", ()=> {
    it("check null args", ()=> {
      expect(api.asyncRemoveSubscribers).to.throw(Error, api.CLIENT_NOT_EXIST);
    });
    it("check remove functionality", ()=> {
      const client = {
        rems: [],
        lrem(tag, num, item, cb) {
          this.rems.push({tag, num, item});
          cb(null, item);
        },
        lrange(tag, start, end, cb) {
          this.tag = tag;
          this.start = start;
          this.end = end;
          cb(null, [4]);
        }
      };
      return api.asyncRemoveSubscribers(client, [2, 3])
        .then((subs)=> {
          expect(subs).to.eql([4]);
          expect(client.rems).to.eql([
            {tag: "SUBSCRIBERS", num: 0, item: 2},
            {tag: "SUBSCRIBERS", num: 0, item: 3}
          ]);
          expect(client.tag).to.eql("SUBSCRIBERS");
          expect(client.start).to.eql(0);
          expect(client.end).to.eql(-1);
        });
    });
  });
  describe("asyncSubscribe", ()=> {
    it("check null args", ()=> {
      expect(api.asyncSubscribe).to.throw(Error, api.CLIENT_NOT_EXIST);
      const failId = ()=> api.asyncSubscribe({});
      expect(failId).to.throw(Error, "argument id doesn't exist");
    });
    it("check subscribe", ()=> {
      const client = {
        rpush(tag, id, cb) {
          this.tag = tag;
          this.id = id;
          cb();
        },
        publish(channel, id, cb) {
          this.channel = channel;
          this.id1 = id;
          cb();
        }
      };
      return api.asyncSubscribe(client, 1)
        .then(()=> {
          expect(client.id).to.eql(1);
          expect(client.id1).to.eql(1);
          expect(client.tag).to.eql("SUBSCRIBERS");
          expect(client.channel).to.eql("channel:SUBSCRIBERS");
        });
    });
  });
  describe("asyncCheckPublisher", ()=> {
    it("check null args", ()=> {
      expect(api.asyncCheckPublisher).to.throw(Error, api.CLIENT_NOT_EXIST);
      const failId = ()=> api.asyncCheckPublisher({});
      expect(failId).to.throw(Error, "argument id doesn't exist");
    });
    it("check for subscriber", ()=> {
      const id = 1;
      const client = {
        get(tag, cb) {
          this.tag = tag;
          cb(null, 2);
        }
      };
      return api.asyncCheckPublisher(client, id)
        .then((isPublisher)=> {
          expect(isPublisher).to.eql(0);
          expect(client.tag).to.eql("SERVERLOCK");
        });
    });
    it("check for publisher", ()=> {
      const id = 1;
      const client = {
        get(tag, cb) {
          this.tag = tag;
          cb(null, id);
        },
        expire(tag, time, cb) {
          this.tag1 = tag;
          this.time1 = time;
          cb(null, 1);
        }
      };
      return api.asyncCheckPublisher(client, id)
        .then((isPublisher)=> {
          expect(isPublisher).to.eql(1);
          expect(client.tag).to.eql("SERVERLOCK");
          expect(client.tag1).to.eql("SERVERLOCK");
          expect(client.time1).to.eql(10);
        });
    });

    it("check for subscriber with free lock", ()=> {
      const id = 1;
      const client = {
        get(tag, cb) {
          this.tag = tag;
          cb();
        },
        setnx(key, id, cb) {
          this.key = key;
          this.id = id;
          cb(null, 1);
        },
        expire(key, expire, cb) {
          this.key1 = key;
          this.expire = expire;
          cb(null, 1);
        }
      };
      return api.asyncCheckPublisher(client, id)
        .then((isPublisher)=> {
          expect(isPublisher).to.eql(1);
          expect(client.tag).to.eql("SERVERLOCK");
          expect(client.id).to.eql(1);
          expect(client.key).to.eql("SERVERLOCK");
          expect(client.key1).to.eql("SERVERLOCK");
          expect(client.expire).to.eql(10);
        });
    });
  });
});
