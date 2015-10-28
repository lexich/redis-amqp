"use strict";
const _ = require("underscore");
const minimist = require("minimist");
const api = require("./lib/api");
const Client = require("./lib/client");

const defaults = {
  host: "127.0.0.1",
  port: "6379",
  level: "log",
  getErrors: null,
};

const argv = _.defaults(minimist(process.argv.slice(2)), defaults);

require("./lib/logger").setLevel(argv.level);
require("./lib/logger").setFormatter((level, date, message)=> {
  return `${level} - ${message}`;
});

const connection = _.pick(argv, ["port", "host"]);
const cfg = _.omit(argv, _.keys(defaults));
if (argv.getErrors) {
  Client.readErrors(api, connection);
} else {
  new Client(api, connection).start(cfg);
}
