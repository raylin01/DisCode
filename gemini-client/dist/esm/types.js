export var JsonStreamEventType;
(function (JsonStreamEventType) {
    JsonStreamEventType["INIT"] = "init";
    JsonStreamEventType["MESSAGE"] = "message";
    JsonStreamEventType["TOOL_USE"] = "tool_use";
    JsonStreamEventType["TOOL_RESULT"] = "tool_result";
    JsonStreamEventType["ERROR"] = "error";
    JsonStreamEventType["RESULT"] = "result";
})(JsonStreamEventType || (JsonStreamEventType = {}));
