"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JsonStreamEventType = void 0;
var JsonStreamEventType;
(function (JsonStreamEventType) {
    JsonStreamEventType["INIT"] = "init";
    JsonStreamEventType["MESSAGE"] = "message";
    JsonStreamEventType["TOOL_USE"] = "tool_use";
    JsonStreamEventType["TOOL_RESULT"] = "tool_result";
    JsonStreamEventType["ERROR"] = "error";
    JsonStreamEventType["RESULT"] = "result";
})(JsonStreamEventType || (exports.JsonStreamEventType = JsonStreamEventType = {}));
