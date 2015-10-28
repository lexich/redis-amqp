"use strict";

module.exports = {
  loggers: [],
  setPath(path) {
    this.path = path;
  },
  setFormatter(fn) {
    if (!fn) { return; }
    this.loggers.forEach((logger)=> logger.format = fn);
  },
  setLevel(mode) {
    this.loggers.forEach((logger)=> logger.setLevel(mode));
  },
  createLogger() {
    const logger = require("logger").createLogger(this.path);
    this.loggers.push(logger);
    return logger;
  }
};
