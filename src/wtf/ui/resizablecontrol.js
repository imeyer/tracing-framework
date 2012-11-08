/**
 * Copyright 2012 Google, Inc. All Rights Reserved.
 *
 * Use of this source code is governed by a BSD-style license that can be
 * found in the LICENSE file.
 */

/**
 * @fileoverview Base resiable control.
 *
 * @author benvanik@google.com (Ben Vanik)
 */

goog.provide('wtf.ui.ResizableControl');

goog.require('goog.Timer');
goog.require('goog.asserts');
goog.require('goog.events');
goog.require('goog.fx.Dragger');
goog.require('goog.math');
goog.require('goog.math.Rect');
goog.require('goog.style');
goog.require('wtf.ui.Control');



/**
 * Base resizable control.
 *
 * @param {wtf.ui.ResizableControl.Orientation} orientation Control orientation.
 * @param {string} splitterClassName CSS name of the splitter div.
 * @param {!Element} parentElement Element to display in.
 * @param {goog.dom.DomHelper=} opt_dom DOM helper.
 * @constructor
 * @extends {wtf.ui.Control}
 */
wtf.ui.ResizableControl = function(orientation, splitterClassName,
    parentElement, opt_dom) {
  goog.base(this, parentElement, opt_dom);

  /**
   * Orientation.
   * @type {wtf.ui.ResizableControl.Orientation}
   * @private
   */
  this.orientation_ = orientation;

  /**
   * Current size in the orientation-defined dimension.
   * @type {number}
   * @private
   */
  this.currentSize_ = 0;
  goog.Timer.callOnce(function() {
    var currentSize = goog.style.getSize(this.getRootElement());
    switch (orientation) {
      case wtf.ui.ResizableControl.Orientation.HORIZONTAL:
        this.currentSize_ = currentSize.height;
        break;
      case wtf.ui.ResizableControl.Orientation.VERTICAL:
        this.currentSize_ = currentSize.width;
        break;
    }
  }, undefined, this);

  /**
   * Minimum size value. If undefined the minimum size is not limited.
   * @type {number|undefined}
   * @private
   */
  this.minimumSize_ = undefined;

  /**
   * Maxmium size value. If undefined the maximum size is not limited.
   * @type {number|undefined}
   * @private
   */
  this.maximumSize_ = undefined;

  /**
   * Splitter <div> element.
   * @type {!Element}
   * @private
   */
  this.splitterDiv_ = /** @type {!Element} */ (this.getDom().getElementByClass(
      splitterClassName, this.getRootElement()));
  goog.asserts.assert(this.splitterDiv_);

  /**
   * Splitter dragger controller.
   * @type {!goog.fx.Dragger}
   * @private
   */
  this.splitterDragger_ = new goog.fx.Dragger(this.splitterDiv_);
  this.registerDisposable(this.splitterDragger_);
  this.getHandler().listen(this.splitterDragger_,
      goog.fx.Dragger.EventType.START, this.splitterDragStart_, false);
  this.getHandler().listen(this.splitterDragger_,
      goog.fx.Dragger.EventType.BEFOREDRAG, this.splitterDragMove_, false);
  this.getHandler().listen(this.splitterDragger_,
      goog.fx.Dragger.EventType.END, this.splitterDragEnd_, false);

  /**
   * Document body cursor at the start of a drag, if any.
   * @type {string|undefined}
   * @private
   */
  this.previousDragCursor_ = undefined;

  // Always trigger a resize once style is available.
  goog.Timer.callOnce(function() {
    this.sizeChanged();
  }, undefined, this);
};
goog.inherits(wtf.ui.ResizableControl, wtf.ui.Control);


/**
 * Events for resizable controls.
 * @enum {string}
 */
wtf.ui.ResizableControl.EventType = {
  SIZE_CHANGED: goog.events.getUniqueId('size_changed')
};


/**
 * Control orientation.
 * @enum {number}
 */
wtf.ui.ResizableControl.Orientation = {
  HORIZONTAL: 0,
  VERTICAL: 1
};


/**
 * Sets the splitter limits.
 * @param {number|undefined} min Minimum value.
 * @param {number|undefined} max Maximum value.
 */
wtf.ui.ResizableControl.prototype.setSplitterLimits = function(min, max) {
  this.minimumSize_ = min;
  this.maximumSize_ = max;
};


/**
 * Gets the current size of the splitter, in px.
 * @return {number} Splitter size.
 */
wtf.ui.ResizableControl.prototype.getSplitterSize = function() {
  return this.currentSize_;
};


/**
 * Sets the splitter size, in px.
 * @param {number} value New splitter size, in px.
 */
wtf.ui.ResizableControl.prototype.setSplitterSize = function(value) {
  // Snap to min/max.
  value = goog.math.clamp(
      value, this.minimumSize_ || 0, this.maximumSize_ || 10000);
  if (this.currentSize_ == value) {
    return;
  }
  this.currentSize_ = value;

  // Resize control.
  switch (this.orientation_) {
    case wtf.ui.ResizableControl.Orientation.HORIZONTAL:
      goog.style.setHeight(this.getRootElement(), value);
      break;
    case wtf.ui.ResizableControl.Orientation.VERTICAL:
      goog.style.setWidth(this.getRootElement(), value);
      break;
  }

  this.sizeChanged();
};


/**
 * Handles splitter drag start events.
 * @param {!goog.fx.DragEvent} e Event.
 * @private
 */
wtf.ui.ResizableControl.prototype.splitterDragStart_ = function(e) {
  // Set dragger limits.
  var limits = new goog.math.Rect(-5000, -5000, 2 * 5000, 2 * 5000);
  switch (this.orientation_) {
    case wtf.ui.ResizableControl.Orientation.HORIZONTAL:
      limits.left = 0;
      limits.width = this.maximumSize_ || 5000;
      break;
    case wtf.ui.ResizableControl.Orientation.VERTICAL:
      limits.top = 0;
      limits.height = this.maximumSize_ || 5000;
      break;
  }
  // -this.maximumSize_,
  // this.maximumSize_ + (this.currentSize_ - this.minimumSize_),
  this.splitterDragger_.setLimits(limits);

  // Reset document cursor to resize so it doesn't flicker.
  var cursorName;
  switch (this.orientation_) {
    case wtf.ui.ResizableControl.Orientation.HORIZONTAL:
      cursorName = 'ns-resize';
      break;
    case wtf.ui.ResizableControl.Orientation.VERTICAL:
      cursorName = 'ew-resize';
      break;
  }
  var body = this.getDom().getDocument().body;
  this.previousDragCursor_ = goog.style.getStyle(body, 'cursor');
  goog.style.setStyle(body, 'cursor', cursorName);
};


/**
 * Handles splitter drag move events.
 * @param {!goog.fx.DragEvent} e Event.
 * @return {boolean} False to prevent default behavior.
 * @private
 */
wtf.ui.ResizableControl.prototype.splitterDragMove_ = function(e) {
  e.browserEvent.preventDefault();

  // Calculate new size and resize.
  var newSize;
  switch (this.orientation_) {
    default:
    case wtf.ui.ResizableControl.Orientation.HORIZONTAL:
      newSize = e.top + 4;
      break;
    case wtf.ui.ResizableControl.Orientation.VERTICAL:
      newSize = e.left + 4;
      break;
  }
  this.setSplitterSize(newSize);
  return false;
};


/**
 * Handles splitter drag end events.
 * @param {!goog.fx.DragEvent} e Event.
 * @private
 */
wtf.ui.ResizableControl.prototype.splitterDragEnd_ = function(e) {
  // Restore document cursor.
  var body = this.getDom().getDocument().body;
  goog.style.setStyle(body, 'cursor', this.previousDragCursor_ || '');
};


/**
 * Handles size changes.
 * @protected
 */
wtf.ui.ResizableControl.prototype.sizeChanged = function() {
  this.emitEvent(wtf.ui.ResizableControl.EventType.SIZE_CHANGED);
};