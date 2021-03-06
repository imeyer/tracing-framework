/**
 * Copyright 2012 Google, Inc. All Rights Reserved.
 *
 * Use of this source code is governed by a BSD-style license that can be
 * found in the LICENSE file.
 */

/**
 * @fileoverview Flow tracking utility.
 *
 * @author benvanik@google.com (Ben Vanik)
 */

goog.provide('wtf.analysis.Flow');

goog.require('wtf.data.EventFlag');



/**
 * Flow tracking utility.
 * A stateful object that is used to help tracking async flows through time.
 * Flows are passed to listeners to enable better tracking.
 *
 * @param {number} flowId Flow ID.
 * @param {wtf.analysis.Flow} parentFlow Parent flow, if any.
 * @constructor
 */
wtf.analysis.Flow = function(flowId, parentFlow) {
  /**
   * Session-unique flow ID.
   * Used to track the flow in the stream.
   * @type {number}
   * @private
   */
  this.flowId_ = flowId;

  /**
   * Parent flow, if any.
   * @type {wtf.analysis.Flow}
   * @private
   */
  this.parentFlow_ = parentFlow;

  /**
   * Branch event for the flow.
   * @type {wtf.analysis.FlowEvent}
   * @private
   */
  this.branchEvent_ = null;

  /**
   * Extend events for the flow.
   * @type {!Array.<!wtf.analysis.FlowEvent>}
   * @private
   */
  this.extendEvents_ = [];

  /**
   * Terminate event for the flow.
   * @type {wtf.analysis.FlowEvent}
   * @private
   */
  this.terminateEvent_ = null;

  /**
   * A list of events that add data to this flow.
   * @type {Array.<!wtf.analysis.Event>}
   * @private
   */
  this.dataEvents_ = null;
};


/**
 * Gets the ID of the flow.
 * This can be sent to servers/other threads/etc to track across processes.
 * @return {number} Flow ID.
 */
wtf.analysis.Flow.prototype.getId = function() {
  return this.flowId_;
};


/**
 * Gets the parent flow of this flow instance.
 * @return {wtf.analysis.Flow} Parent flow, if any.
 */
wtf.analysis.Flow.prototype.getParent = function() {
  return this.parentFlow_;
};


/**
 * Gets the branch event for the flow.
 * @return {wtf.analysis.FlowEvent} Branch event, if any.
 */
wtf.analysis.Flow.prototype.getBranchEvent = function() {
  return this.branchEvent_;
};


/**
 * Sets the branch event for the flow.
 * @param {!wtf.analysis.FlowEvent} e Event.
 */
wtf.analysis.Flow.prototype.setBranchEvent = function(e) {
  this.branchEvent_ = e;
};


/**
 * Gets the extend events for the flow.
 * @return {!Array.<!wtf.analysis.FlowEvent>} Extend events, if any. Do not
 *     modify.
 */
wtf.analysis.Flow.prototype.getExtendEvents = function() {
  return this.extendEvents_;
};


/**
 * Adds an extend event for the flow.
 * @param {!wtf.analysis.FlowEvent} e Event.
 */
wtf.analysis.Flow.prototype.addExtendEvent = function(e) {
  this.extendEvents_.push(e);
};


/**
 * Gets the terminate event for the flow.
 * @return {wtf.analysis.FlowEvent} Terminate event, if any.
 */
wtf.analysis.Flow.prototype.getTerminateEvent = function() {
  return this.terminateEvent_;
};


/**
 * Sets the terminate event for the flow.
 * @param {!wtf.analysis.FlowEvent} e Event.
 */
wtf.analysis.Flow.prototype.setTerminateEvent = function(e) {
  this.terminateEvent_ = e;
};


/**
 * Adds a data event.
 * This events arguments will be used when building the flow data.
 * @param {!wtf.analysis.Event} e Event to add.
 */
wtf.analysis.Flow.prototype.addDataEvent = function(e) {
  if (!this.dataEvents_) {
    this.dataEvents_ = [e];
  } else {
    this.dataEvents_.push(e);
  }
};


/**
 * Gets the flow data as a key-value map.
 * This is all data appended by events.
 * @return {Object} Flow data, if any.
 */
wtf.analysis.Flow.prototype.getData = function() {
  var data = {};
  if (this.dataEvents_) {
    for (var n = 0; n < this.dataEvents_.length; n++) {
      var e = this.dataEvents_[n];
      if (e.eventType.flags & wtf.data.EventFlag.INTERNAL) {
        // name-value pair from the builtin appending functions.
        data[e.args['name']] = e.args['value'];
      } else {
        // Custom appender, use args.
        // Skip the flow ID.
        for (var m = 1; m < e.eventType.args.length; m++) {
          var arg = e.eventType.args[m];
          data[arg.name] = e.args[arg.name];
        }
      }
    }
  }
  return data;
};


goog.exportSymbol(
    'wtf.analysis.Flow',
    wtf.analysis.Flow);
goog.exportProperty(
    wtf.analysis.Flow.prototype, 'getId',
    wtf.analysis.Flow.prototype.getId);
goog.exportProperty(
    wtf.analysis.Flow.prototype, 'getParent',
    wtf.analysis.Flow.prototype.getParent);
goog.exportProperty(
    wtf.analysis.Flow.prototype, 'getBranchEvent',
    wtf.analysis.Flow.prototype.getBranchEvent);
goog.exportProperty(
    wtf.analysis.Flow.prototype, 'getExtendEvents',
    wtf.analysis.Flow.prototype.getExtendEvents);
goog.exportProperty(
    wtf.analysis.Flow.prototype, 'getTerminateEvent',
    wtf.analysis.Flow.prototype.getTerminateEvent);
goog.exportProperty(
    wtf.analysis.Flow.prototype, 'getData',
    wtf.analysis.Flow.prototype.getData);
