/**
 * Copyright 2015 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

var cls = require('../../cls.js');
var shimmer = require('shimmer');
var semver = require('semver');
var SpanData = require('../../span-data.js');
var agent;

var SUPPORTED_VERSIONS = '<=2.x';

function createClientWrap(createClient) {
  return function createClientTrace() {
    var client = createClient.apply(this, arguments);
    cls.getNamespace().bindEmitter(client);
    return client;
  };
}

function streamListenersWrap(install_stream_listeners) {
  return function install_stream_listeners_trace() {
    cls.getNamespace().bindEmitter(this.stream);
    return install_stream_listeners.apply(this, arguments);
  };
}

function sendCommandWrap(send_command) {
  return function send_command_trace(cmd, args, cb) {
    var root = cls.getRootContext();
    if (!root) {
      agent.logger.warn('Cannot trace redis outside of a supported framework.');
      agent.logger.debug('Untraced redis command:', cmd, args);
      return send_command.call(this, cmd, args, cb);
    } else if (root === SpanData.nullSpan) {
      return send_command.call(this, cmd, args, cb);
    }
    if (!cmd || !args || typeof cmd !== 'string' || !Array.isArray(args) ||
        (cb && typeof cb !== 'function')) {
      return send_command.call(this, cmd, args, cb);
    }
    if (!cb) {
      if (typeof args[args.length - 1] === 'function' ||
          typeof args[args.length - 1] === 'undefined') {
        cb = args.pop();
      }
    }
    var labels = { command: cmd };
    if (agent.config_.enhancedDatabaseReporting) {
      labels.arguments = JSON.stringify(args);
    }
    var span = agent.startSpan('redis-' + cmd, labels);
    return send_command.call(this, cmd, args, wrapCallback(span, cb));
  };
}

function wrapCallback(span, done) {
  var fn = function(err, res) {
    var labels = {};
    if (agent.config_.enhancedDatabaseReporting) {
      if (err) {
        labels.error = err;
      }
      if (res) {
        labels.result = res;
      }
    }
    agent.endSpan(span, labels);
    if (done) {
      done(err, res);
    }
  };
  return cls.getNamespace().bind(fn);
}

module.exports = function(version_, agent_) {
  if (!semver.satisfies(version_, SUPPORTED_VERSIONS)) {
    agent_.logger.info('Redis: unsupported version ' + version_ + ' loaded');
    return {};
  }
  return {
    // An empty relative path here matches the root module being loaded.
    '': {
      patch: function(redis) {
        agent = agent_;
        shimmer.wrap(redis.RedisClient.prototype, 'send_command', sendCommandWrap);
        shimmer.wrap(redis.RedisClient.prototype, 'install_stream_listeners',
          streamListenersWrap);
        shimmer.wrap(redis, 'createClient', createClientWrap);
      },
      unpatch: function(redis) {
        shimmer.unwrap(redis.RedisClient.prototype, 'send_command');
        shimmer.unwrap(redis.RedisClient.prototype, 'install_stream_listeners');
        shimmer.unwrap(redis, 'createClient');
        agent_.logger.info('Redis: unpatched');
      }
    }
  };
};
