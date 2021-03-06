/**
 * Copyright 2012 Google, Inc. All Rights Reserved.
 *
 * Use of this source code is governed by a BSD-style license that can be
 * found in the LICENSE file.
 */

/**
 * @fileoverview Event database.
 *
 * @author benvanik@google.com (Ben Vanik)
 */

goog.provide('wtf.analysis.db.EventDatabase');

goog.require('goog.asserts');
goog.require('goog.async.Deferred');
goog.require('goog.events');
goog.require('wtf');
goog.require('wtf.analysis.Event');
goog.require('wtf.analysis.EventFilter');
goog.require('wtf.analysis.ScopeEvent');
goog.require('wtf.analysis.TraceListener');
goog.require('wtf.analysis.db.EventIndex');
goog.require('wtf.analysis.db.QueryResult');
goog.require('wtf.analysis.db.SummaryIndex');
goog.require('wtf.analysis.db.ZoneIndex');
goog.require('wtf.data.EventFlag');
goog.require('wtf.events.EventEmitter');
goog.require('wtf.events.EventType');



/**
 * Virtualized event database.
 * The event database is an in-memory (and potentially file-backed) selectable
 * database of events. It's designed to injest data from out-of-order event
 * streams and generate a structure that is fast to seek and can contain
 * aggregate data.
 *
 * Databases themselves cannot be queried directly, but have views and indices
 * that manage the data. These views respond to events (such as data updating)
 * and can quickly query their current region of interest.
 *
 * Future versions can be file-backed (or contain extra information) to enable
 * virtualization by generating the higher-level data structures and discarding
 * data not immediately required.
 *
 * Databases contain a time index that references event data chunks.
 * Applications can add their own event-based indices to allow for more control
 * over iteration.
 *
 * @constructor
 * @extends {wtf.events.EventEmitter}
 * @implements {wgxpath.Node}
 */
wtf.analysis.db.EventDatabase = function() {
  goog.base(this);

  /**
   * All sources that have been added to provide event data.
   * @type {!Array.<!wtf.data.ContextInfo>}
   * @private
   */
  this.sources_ = [];

  /**
   * Total number of events added.
   * This excludes uninteresting events (like scope leaves) and should only be
   * used for display.
   * @type {number}
   * @private
   */
  this.totalEventCount_ = 0;

  /**
   * Summary index.
   * @type {!wtf.analysis.db.SummaryIndex}
   * @private
   */
  this.summaryIndex_ = new wtf.analysis.db.SummaryIndex();
  this.registerDisposable(this.summaryIndex_);

  /**
   * Indicies for all zones seen in the stream.
   * @type {!Array.<!wtf.analysis.db.ZoneIndex>}
   * @private
   */
  this.zoneIndices_ = [];

  /**
   * All registered event indices.
   * @type {!Array.<!wtf.analysis.db.EventIndex>}
   * @private
   */
  this.eventIndices_ = [];

  /**
   * Trace listener subclass that redirects events into the database.
   * @type {!wtf.analysis.db.EventDatabase.Listener_}
   * @private
   */
  this.listener_ = new wtf.analysis.db.EventDatabase.Listener_(this);
};
goog.inherits(wtf.analysis.db.EventDatabase, wtf.events.EventEmitter);


/**
 * @override
 */
wtf.analysis.db.EventDatabase.prototype.disposeInternal = function() {
  goog.disposeAll(this.eventIndices_);
  goog.disposeAll(this.zoneIndices_);
  goog.base(this, 'disposeInternal');
};


/**
 * Event types for the database.
 * @enum {string}
 */
wtf.analysis.db.EventDatabase.EventType = {
  /**
   * The sources listing changed (source added/etc).
   */
  SOURCES_CHANGED: goog.events.getUniqueId('sources_changed'),

  /**
   * A source had an error parsing an input.
   * Args: [message, opt_detail]
   */
  SOURCE_ERROR: goog.events.getUniqueId('source_error'),

  /**
   * One or more zones was added. Args include a list of the added zones.
   */
  ZONES_ADDED: goog.events.getUniqueId('zones_added')
};


/**
 * @override
 */
wtf.analysis.db.EventDatabase.prototype.toString = function() {
  return 'db';
};


/**
 * Gets a list of all sources that have been added to provide event data.
 * @return {!Array.<!wtf.data.ContextInfo>} A list of all sources. Do not
 *     modify.
 */
wtf.analysis.db.EventDatabase.prototype.getSources = function() {
  return this.sources_;
};


/**
 * Gets the total number of interesting events.
 * This excludes things such as scope leaves.
 * @return {number} Event count.
 */
wtf.analysis.db.EventDatabase.prototype.getTotalEventCount = function() {
  return this.totalEventCount_;
};


/**
 * Gets the timebase that all event times are relative to.
 * This, when added to an events time, can be used to compute the wall-time
 * the event occurred at.
 * @return {number} Timebase.
 */
wtf.analysis.db.EventDatabase.prototype.getTimebase = function() {
  return this.listener_.getCommonTimebase();
};


/**
 * Gets the time of the first event in the index.
 * @return {number} Time of the first event or 0 if no events.
 */
wtf.analysis.db.EventDatabase.prototype.getFirstEventTime = function() {
  return this.summaryIndex_.getFirstEventTime();
};


/**
 * Gets the time of the last event in the index.
 * @return {number} Time of the last event or 0 if no events.
 */
wtf.analysis.db.EventDatabase.prototype.getLastEventTime = function() {
  return this.summaryIndex_.getLastEventTime();
};


/**
 * Gets the summary index.
 * @return {!wtf.analysis.db.SummaryIndex} Summary index.
 */
wtf.analysis.db.EventDatabase.prototype.getSummaryIndex = function() {
  return this.summaryIndex_;
};


/**
 * Gets all of the zone indices.
 * @return {!Array.<!wtf.analysis.db.ZoneIndex>} Zone indices. Do not modify.
 */
wtf.analysis.db.EventDatabase.prototype.getZoneIndices = function() {
  return this.zoneIndices_;
};


/**
 * Gets the first valid frame index.
 * @return {wtf.analysis.db.FrameIndex} Frame index, if any.
 */
wtf.analysis.db.EventDatabase.prototype.getFirstFrameIndex = function() {
  for (var n = 0; n < this.zoneIndices_.length; n++) {
    var frameIndex = this.zoneIndices_[n].getFrameIndex();
    if (frameIndex.getCount()) {
      return frameIndex;
    }
  }
  return null;
};


/**
 * Creates a new event index in the database.
 * This may take some time to complete if the database already contains data.
 *
 * If the index already exists it will be returned. Because of this it's best
 * to always attempt creating an index unless you know for sure it exists.
 *
 * @param {string} eventName Event name.
 * @return {!goog.async.Deferred} A deferred fulfilled when the index is ready.
 *     Successful callbacks receive the new event index as the only argument.
 */
wtf.analysis.db.EventDatabase.prototype.createEventIndex = function(eventName) {
  // Quick check to see if it already exists.
  var eventIndex = this.getEventIndex(eventName);
  if (eventIndex) {
    return goog.async.Deferred.succeed(eventIndex);
  }

  // Create the index (empty).
  eventIndex = new wtf.analysis.db.EventIndex(eventName);
  this.eventIndices_.push(eventIndex);

  // TODO(benvanik): async loading support (add to waiter list/etc)
  // This is a hack to synchronously populate the index.
  //eventIndex.beginInserting();
  // hmm already lost the events... what to do?
  //eventIndex.endInserting();

  return goog.async.Deferred.succeed(eventIndex);
};


/**
 * Gets the event index for the given event info, if it exists.
 * Note that the result of this method should be cached for efficiency.
 * @param {string} eventName Event name.
 * @return {wtf.analysis.db.EventIndex} Event index, if found.
 */
wtf.analysis.db.EventDatabase.prototype.getEventIndex = function(eventName) {
  for (var n = 0; n < this.eventIndices_.length; n++) {
    var eventIndex = this.eventIndices_[n];
    if (eventIndex.getEventName() == eventName) {
      return eventIndex;
    }
  }
  return null;
};


/**
 * Gets the internal trace listener.
 * @return {!wtf.analysis.TraceListener} Trace listener.
 */
wtf.analysis.db.EventDatabase.prototype.getTraceListener = function() {
  return this.listener_;
};


/**
 * Handles database structure invalidation (new sources/etc).
 * @private
 */
wtf.analysis.db.EventDatabase.prototype.invalidate_ = function() {
  this.emitEvent(wtf.events.EventType.INVALIDATED);
};


/**
 * Renumbers all events in the database.
 * This gives all events a database-absolute position used for sorting.
 * @private
 */
wtf.analysis.db.EventDatabase.prototype.renumber_ = function() {
  var position = 0;
  // The database is always at position 0.
  position++;
  for (var n = 0; n < this.zoneIndices_.length; n++) {
    var zoneIndex = this.zoneIndices_[n];
    position = zoneIndex.renumber(position);
  }
};


/**
 * Queries the database.
 * Throws errors if the expression could not be parsed.
 * @param {string} expr Query string.
 * @return {wtf.analysis.db.QueryResult} Result.
 */
wtf.analysis.db.EventDatabase.prototype.query = function(expr) {
  // Try to figure out what type the query is.
  // First, we see if it's some kind of simple substring (starts without /)
  // or a regex (starts and ends with /). If that's true, we use the
  // event filter logic to populate the table.
  // Otherwise, we assume they are trying to type an xpath expression. Note that
  // this will cause someone typing a regex to have the intermediate stages
  // interpreted as an xpath query, but that's ok.
  var isFilter = false;
  if (expr.charAt(0) != '/' &&
      expr.indexOf('(') == -1) {
    // Definitely a substring.
    isFilter = true;
  } else if (/^\/(.+)\/([gim]*)$/.test(expr)) {
    // Likely a regex, very rare for a query to match this, so trust it.
    isFilter = true;
  } else {
    // Likely an xpath query, do that.
    isFilter = false;
  }

  var startTime = wtf.now();

  var compiledExpr = null;
  var result = null;
  if (isFilter) {
    // Create filter.
    var filter = new wtf.analysis.EventFilter();
    var parseResult = filter.setFromString(expr);
    if (parseResult == wtf.analysis.EventFilter.Result.FAILED) {
      throw 'Invalid regex.';
    }

    result = [];
    var evaluator = filter.getEvaluator();
    for (var n = 0; n < this.zoneIndices_.length; n++) {
      var zoneIndex = this.zoneIndices_[n];
      zoneIndex.forEach(Number.MIN_VALUE, Number.MAX_VALUE, function(e) {
        if (e.eventType.flags & wtf.data.EventFlag.INTERNAL) {
          return;
        }
        if (!evaluator || evaluator(e)) {
          if (e instanceof wtf.analysis.ScopeEvent) {
            result.push(e.scope);
          } else {
            result.push(e);
          }
        }
      });
    }
    result.sort(wtf.analysis.Event.comparer);

    compiledExpr = filter.getEvaluator().toString();
  } else {
    // Create the XPath expression.
    // TODO(benvanik): better error handling around this?
    var xexpr = new wgxpath.XPathExpression(expr || '.');

    // Run the XPath query on the database.
    var context = this;
    var xresult = xexpr.evaluate(context, wgxpath.XPathResultType.ANY_TYPE);

    compiledExpr = xexpr;
    result = xresult.value;
  }

  var duration = wtf.now() - startTime;
  return new wtf.analysis.db.QueryResult(expr, compiledExpr, duration, result);
};


/**
 * @override
 */
wtf.analysis.db.EventDatabase.prototype.getNodeType = function() {
  return wgxpath.NodeType.DATABASE;
};


/**
 * @override
 */
wtf.analysis.db.EventDatabase.prototype.getNodePosition = function() {
  // Database is always at 0.
  return 0;
};


/**
 * @override
 */
wtf.analysis.db.EventDatabase.prototype.getNodeName = function() {
  return 'db';
};


/**
 * @override
 */
wtf.analysis.db.EventDatabase.prototype.getNodeValue = function() {
  return '';
};


/**
 * @override
 */
wtf.analysis.db.EventDatabase.prototype.getRootNode = function() {
  return this;
};


/**
 * @override
 */
wtf.analysis.db.EventDatabase.prototype.getParentNode = function() {
  return null;
};


/**
 * @override
 */
wtf.analysis.db.EventDatabase.prototype.getPreviousSiblingNode = function() {
  return null;
};


/**
 * @override
 */
wtf.analysis.db.EventDatabase.prototype.getNextSiblingNode = function() {
  return null;
};


/**
 * @override
 */
wtf.analysis.db.EventDatabase.prototype.gatherChildNodes = function(
    nodeset, opt_test, opt_attrName, opt_attrValue) {
  for (var n = 0; n < this.zoneIndices_.length; n++) {
    var zoneIndex = this.zoneIndices_[n];
    if (!opt_test || opt_test.matches(zoneIndex)) {
      if (!opt_attrName ||
          wgxpath.Node.attrMatches(zoneIndex, opt_attrName, opt_attrValue)) {
        nodeset.add(zoneIndex);
      }
    }
  }
};


/**
 * @override
 */
wtf.analysis.db.EventDatabase.prototype.gatherDescendantNodes = function(
    nodeset, opt_test, opt_attrName, opt_attrValue) {
  for (var n = 0; n < this.zoneIndices_.length; n++) {
    var zoneIndex = this.zoneIndices_[n];
    if (!opt_test || opt_test.matches(zoneIndex)) {
      if (!opt_attrName ||
          wgxpath.Node.attrMatches(zoneIndex, opt_attrName, opt_attrValue)) {
        nodeset.add(zoneIndex);
      }
    }
    zoneIndex.gatherDescendantNodes(
        nodeset, opt_test, opt_attrName, opt_attrValue);
  }
};


/**
 * @override
 */
wtf.analysis.db.EventDatabase.prototype.getAttributes = function() {
  return null;
};


/**
 * @override
 */
wtf.analysis.db.EventDatabase.prototype.getAttribute = function(name) {
  return null;
};



/**
 * Trace listener implementation that adds events to the database.
 *
 * @param {!wtf.analysis.db.EventDatabase} db Target database.
 * @constructor
 * @extends {wtf.analysis.TraceListener}
 * @private
 */
wtf.analysis.db.EventDatabase.Listener_ = function(db) {
  goog.base(this);

  /**
   * Target event database.
   * @type {!wtf.analysis.db.EventDatabase}
   * @private
   */
  this.db_ = db;

  // TODO(benvanik): setup event indices/etc as listeners for the event type
  //     names - this would make things much more efficient as the number of
  //     indices grows.
  /**
   * A list of event targets for insertion notification.
   * This list is rebuilt each insertion block and is in a specific order.
   * @type {!Array.<!wtf.analysis.db.IEventTarget>}
   * @private
   */
  this.eventTargets_ = [];

  /**
   * Whether the listener is inside an insertion block.
   * @type {boolean}
   * @private
   */
  this.insertingEvents_ = false;

  /**
   * Number of events added in the current insert block so far.
   * @type {number}
   * @private
   */
  this.insertedEventCount_ = 0;

  /**
   * The number of zones when insertion began.
   * Used to track new zones.
   * @type {number}
   * @private
   */
  this.beginningZoneCount_ = 0;

  /**
   * Start-time of the dirty range.
   * @type {number}
   * @private
   */
  this.dirtyTimeStart_ = 0;

  /**
   * End-time of the dirty range.
   * @type {number}
   * @private
   */
  this.dirtyTimeEnd_ = 0;

  // TODO(benvanik): cleanup, issue #196.
  /**
   * Cached event types, for performance.
   * @type {!Object.<!wtf.analysis.EventType>}
   * @private
   */
  this.eventTypes_ = {
    zoneCreate: null,
    scopeLeave: null
  };
};
goog.inherits(wtf.analysis.db.EventDatabase.Listener_,
    wtf.analysis.TraceListener);


/**
 * @override
 */
wtf.analysis.db.EventDatabase.Listener_.prototype.sourceAdded =
    function(timebase, contextInfo) {
  this.db_.sources_.push(contextInfo);
  this.db_.emitEvent(wtf.analysis.db.EventDatabase.EventType.SOURCES_CHANGED);
  this.db_.invalidate_();
};


/**
 * @override
 */
wtf.analysis.db.EventDatabase.Listener_.prototype.sourceError =
    function(message, opt_detail) {
  this.db_.emitEvent(wtf.analysis.db.EventDatabase.EventType.SOURCE_ERROR,
      message, opt_detail);
};


/**
 * @override
 */
wtf.analysis.db.EventDatabase.Listener_.prototype.beginEventBatch =
    function(contextInfo) {
  goog.asserts.assert(!this.insertingEvents_);
  this.insertingEvents_ = true;

  this.beginningZoneCount_ = this.db_.zoneIndices_.length;
  this.dirtyTimeStart_ = Number.MAX_VALUE;
  this.dirtyTimeEnd_ = Number.MIN_VALUE;

  // Rebuild the target list.
  var db = this.db_;
  this.eventTargets_.length = 0;
  this.eventTargets_.push(db.summaryIndex_);
  this.eventTargets_.push.apply(this.eventTargets_, db.zoneIndices_);
  this.eventTargets_.push.apply(this.eventTargets_, db.eventIndices_);

  // Begin inserting.
  for (var n = 0; n < this.eventTargets_.length; n++) {
    this.eventTargets_[n].beginInserting();
  }
};


/**
 * @override
 */
wtf.analysis.db.EventDatabase.Listener_.prototype.endEventBatch = function() {
  goog.asserts.assert(this.insertingEvents_);
  this.insertingEvents_ = false;

  // End inserting.
  for (var n = this.eventTargets_.length - 1; n >= 0; n--) {
    this.eventTargets_[n].endInserting();
  }

  // Renumber the database.
  // This could be really slow, and should be done incrementally if possible.
  this.db_.renumber_();

  // Track added zones and emit the event.
  if (this.beginningZoneCount_ != this.db_.zoneIndices_.length) {
    var addedZones = this.db_.zoneIndices_.slice(this.beginningZoneCount_);
    this.db_.emitEvent(
        wtf.analysis.db.EventDatabase.EventType.ZONES_ADDED, addedZones);
  }

  // Notify watchers.
  if (this.insertedEventCount_) {
    this.insertedEventCount_ = 0;
    this.db_.invalidate_();
  }

  this.eventTargets_.length = 0;
};


/**
 * @override
 */
wtf.analysis.db.EventDatabase.Listener_.prototype.traceEvent = function(e) {
  if (e.time < this.dirtyTimeStart_) {
    this.dirtyTimeStart_ = e.time;
  }
  if (e.time > this.dirtyTimeEnd_) {
    this.dirtyTimeEnd_ = e.time;
  }
  this.insertedEventCount_++;

  // TODO(benvanik): cleanup, issue #196.
  if (!this.eventTypes_.scopeLeave) {
    this.eventTypes_.scopeLeave = this.getEventType('wtf.scope#leave');
  }
  if (!this.eventTypes_.zoneCreate) {
    this.eventTypes_.zoneCreate = this.getEventType('wtf.zone#create');
  }

  if (!(e.eventType.flags & wtf.data.EventFlag.INTERNAL ||
      e.eventType == this.eventTypes_.scopeLeave)) {
    // Scope leave - subtract from total count.
    this.db_.totalEventCount_++;
  }

  // Handle zone creation.
  // This happens first so that if we create a new zone it's added to the
  // event targets list.
  if (e.eventType == this.eventTypes_.zoneCreate) {
    // Create a new zone index.
    var newZone = e.value;
    // Check to see if the zone is already created - we'll get double creates
    // for zones created while the trace was running.
    var present = false;
    for (var n = 0; n < this.db_.zoneIndices_.length; n++) {
      if (this.db_.zoneIndices_[n].getZone() == newZone) {
        present = true;
        break;
      }
    }
    if (!present) {
      var zoneIndex = new wtf.analysis.db.ZoneIndex(this.db_, newZone);
      this.db_.zoneIndices_.push(zoneIndex);
      this.eventTargets_.push(zoneIndex);
      zoneIndex.beginInserting();
    }
  }

  // Dispatch to targets.
  for (var n = 0; n < this.eventTargets_.length; n++) {
    this.eventTargets_[n].insertEvent(e);
  }
};


goog.exportSymbol(
    'wtf.analysis.db.EventDatabase',
    wtf.analysis.db.EventDatabase);
goog.exportProperty(
    wtf.analysis.db.EventDatabase.prototype, 'getSources',
    wtf.analysis.db.EventDatabase.prototype.getSources);
goog.exportProperty(
    wtf.analysis.db.EventDatabase.prototype, 'getTotalEventCount',
    wtf.analysis.db.EventDatabase.prototype.getTotalEventCount);
goog.exportProperty(
    wtf.analysis.db.EventDatabase.prototype, 'getTimebase',
    wtf.analysis.db.EventDatabase.prototype.getTimebase);
goog.exportProperty(
    wtf.analysis.db.EventDatabase.prototype, 'getFirstEventTime',
    wtf.analysis.db.EventDatabase.prototype.getFirstEventTime);
goog.exportProperty(
    wtf.analysis.db.EventDatabase.prototype, 'getLastEventTime',
    wtf.analysis.db.EventDatabase.prototype.getLastEventTime);
goog.exportProperty(
    wtf.analysis.db.EventDatabase.prototype, 'getSummaryIndex',
    wtf.analysis.db.EventDatabase.prototype.getSummaryIndex);
goog.exportProperty(
    wtf.analysis.db.EventDatabase.prototype, 'getZoneIndices',
    wtf.analysis.db.EventDatabase.prototype.getZoneIndices);
goog.exportProperty(
    wtf.analysis.db.EventDatabase.prototype, 'createEventIndex',
    wtf.analysis.db.EventDatabase.prototype.createEventIndex);
goog.exportProperty(
    wtf.analysis.db.EventDatabase.prototype, 'getEventIndex',
    wtf.analysis.db.EventDatabase.prototype.getEventIndex);
goog.exportProperty(
    wtf.analysis.db.EventDatabase.prototype, 'getTraceListener',
    wtf.analysis.db.EventDatabase.prototype.getTraceListener);
goog.exportProperty(
    wtf.analysis.db.EventDatabase.prototype, 'query',
    wtf.analysis.db.EventDatabase.prototype.query);
