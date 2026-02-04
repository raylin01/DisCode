// @bun
var __require = import.meta.require;

// src/plugins/claude-sdk-plugin.ts
import { spawn } from "child_process";
import { createInterface } from "readline";
import { EventEmitter as EventEmitter2 } from "events";
import { randomUUID } from "crypto";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";

// src/plugins/base.ts
import { EventEmitter } from "events";

class BasePlugin extends EventEmitter {
  sessions = new Map;
  async initialize() {
    console.log(`[${this.name}] Initializing...`);
  }
  async shutdown() {
    console.log(`[${this.name}] Shutting down...`);
    for (const session of this.sessions.values()) {
      await session.close();
    }
    this.sessions.clear();
  }
  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }
  async destroySession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      await session.close();
      this.sessions.delete(sessionId);
    }
  }
  getSessions() {
    return Array.from(this.sessions.values());
  }
  log(message2) {
    console.log(`[${this.name}] ${message2}`);
  }
  debug(message2) {
    if (process.env.DEBUG) {
      console.log(`[${this.name}:debug] ${message2}`);
    }
  }
}

// src/plugins/claude-sdk-plugin.ts
class ClaudeSDKSession extends EventEmitter2 {
  sessionId;
  config;
  createdAt;
  isOwned = true;
  status = "idle";
  lastActivity;
  process = null;
  stdinReady = false;
  processExited = false;
  currentRequestId = null;
  pendingControlRequests = new Map;
  currentTool = null;
  currentToolInput = {};
  currentToolUseId = null;
  currentContent = "";
  currentThinking = "";
  seenToolUses = new Set;
  debugLogPath = null;
  textBuffer = "";
  batchTimer = null;
  BATCH_DELAY = 500;
  currentOutputType = "stdout";
  currentActivity = null;
  isThinking = false;
  plugin;
  constructor(config, plugin) {
    super();
    this.sessionId = config.sessionId;
    this.config = config;
    this.createdAt = new Date;
    this.lastActivity = new Date;
    this.plugin = plugin;
    const debugDir = "/tmp/claude-sdk-debug";
    try {
      mkdirSync(debugDir, { recursive: true });
    } catch (e) {}
    this.debugLogPath = join(debugDir, `${this.sessionId}.jsonl`);
    this.debugLog("=== SESSION START ===", { sessionId: this.sessionId, timestamp: new Date().toISOString() });
  }
  get isReady() {
    return this.stdinReady && !this.processExited;
  }
  on(event, listener) {
    if (this.isReady && event === "ready") {
      setImmediate(() => listener());
    }
    return super.on(event, listener);
  }
  once(event, listener) {
    if (this.isReady && event === "ready") {
      setImmediate(() => listener());
      return this;
    }
    return super.once(event, listener);
  }
  async sendMessage(message2) {
    if (this.processExited) {
      throw new Error("Process has exited");
    }
    this.lastActivity = new Date;
    this.status = "working";
    this.currentContent = "";
    this.currentTool = null;
    this.isThinking = false;
    this.currentOutputType = "stdout";
    this.flushTextBuffer();
    this.setActivity("Processing");
    this.plugin.log(`[${this.sessionId.slice(0, 8)}] Sending: "${message2.slice(0, 50)}..."`);
    const inputMessage = {
      type: "user",
      session_id: this.sessionId,
      message: {
        role: "user",
        content: [{ type: "text", text: message2 }]
      },
      parent_tool_use_id: null
    };
    await this.writeToStdin(JSON.stringify(inputMessage));
  }
  async sendApproval(optionNumber) {
    const pendingQuestion = this.pendingQuestion;
    this.plugin.log(`[${this.sessionId.slice(0, 8)}] sendApproval called: optionNumber=${optionNumber}, pendingQuestion exists=${!!pendingQuestion}`);
    if (pendingQuestion) {
      this.plugin.log(`[${this.sessionId.slice(0, 8)}] pendingQuestion structure:`, JSON.stringify({
        hasQuestions: !!pendingQuestion.questions,
        questionsCount: pendingQuestion.questions?.length,
        currentQuestionIndex: pendingQuestion.currentQuestionIndex,
        hasCurrentOptions: !!pendingQuestion.currentOptions,
        answersCollected: pendingQuestion.allAnswers?.length || 0
      }));
    }
    if (pendingQuestion && pendingQuestion.currentOptions && pendingQuestion.currentOptions.length > 0) {
      if (optionNumber.includes(",")) {
        this.plugin.log(`[${this.sessionId.slice(0, 8)}] Multi-select submission detected: ${optionNumber}`);
        const optionNumbers = optionNumber.split(",").map((s) => s.trim());
        for (const optNum of optionNumbers) {
          if (optNum === "0") {
            const otherValue = message || "Other";
            pendingQuestion.allAnswers.push(otherValue);
            this.plugin.log(`[${this.sessionId.slice(0, 8)}] Collected "Other" answer: "${otherValue}"`);
            continue;
          }
          const optionIndex2 = parseInt(optNum, 10) - 1;
          this.plugin.log(`[${this.sessionId.slice(0, 8)}] Processing option ${optionIndex2} (from ${optNum})`);
          if (optionIndex2 >= 0 && optionIndex2 < pendingQuestion.currentOptions.length) {
            const option = pendingQuestion.currentOptions[optionIndex2];
            let optionValue;
            if (typeof option === "string") {
              optionValue = option;
            } else if (option && typeof option === "object") {
              optionValue = option.value || option.label || `Option ${optionIndex2 + 1}`;
            } else {
              optionValue = `Option ${optionIndex2 + 1}`;
            }
            pendingQuestion.allAnswers.push(optionValue);
            this.plugin.log(`[${this.sessionId.slice(0, 8)}] Collected multi-select answer: "${optionValue}"`);
          } else {
            this.plugin.log(`[${this.sessionId.slice(0, 8)}] Option index ${optionIndex2} out of range`);
          }
        }
        pendingQuestion.currentQuestionIndex++;
        await this.askNextQuestion();
        return;
      }
      if (optionNumber === "0") {
        const otherValue = message || "Other";
        pendingQuestion.allAnswers.push(otherValue);
        this.plugin.log(`[${this.sessionId.slice(0, 8)}] Collected single "Other" answer: "${otherValue}"`);
        pendingQuestion.currentQuestionIndex++;
        await this.askNextQuestion();
        return;
      }
      const optionIndex = parseInt(optionNumber, 10) - 1;
      this.plugin.log(`[${this.sessionId.slice(0, 8)}] Option index: ${optionIndex} (from button ${optionNumber})`);
      if (optionIndex >= 0 && optionIndex < pendingQuestion.currentOptions.length) {
        const option = pendingQuestion.currentOptions[optionIndex];
        let optionValue;
        if (typeof option === "string") {
          optionValue = option;
          this.plugin.log(`[${this.sessionId.slice(0, 8)}] Option ${optionIndex} is string: "${optionValue}"`);
        } else if (option && typeof option === "object") {
          const keys = Object.keys(option);
          this.plugin.log(`[${this.sessionId.slice(0, 8)}] Option ${optionIndex} is object with keys: ${keys.join(", ")}`);
          this.plugin.log(`[${this.sessionId.slice(0, 8)}] Option ${optionIndex}: label="${option.label || "N/A"}", value="${option.value || "N/A"}"`);
          optionValue = option.value || option.label || `Option ${optionIndex + 1}`;
          this.plugin.log(`[${this.sessionId.slice(0, 8)}] Extracted value: "${optionValue}"`);
        } else {
          optionValue = `Option ${optionIndex + 1}`;
          this.plugin.log(`[${this.sessionId.slice(0, 8)}] Option ${optionIndex} is ${typeof option}, using fallback: "${optionValue}"`);
        }
        pendingQuestion.allAnswers.push(optionValue);
        this.plugin.log(`[${this.sessionId.slice(0, 8)}] Collected answer ${pendingQuestion.allAnswers.length}: "${optionValue}"`);
        pendingQuestion.currentQuestionIndex++;
        await this.askNextQuestion();
        return;
      } else {
        this.plugin.log(`[${this.sessionId.slice(0, 8)}] Option index ${optionIndex} out of range (0-${pendingQuestion.currentOptions.length - 1})`);
      }
    }
    const behaviorMap = {
      "1": "allow",
      "2": "deny",
      "3": "delegate"
    };
    const behavior = behaviorMap[optionNumber] || "allow";
    const response = {
      behavior,
      toolUseID: this.currentRequestId
    };
    this.plugin.log(`[${this.sessionId.slice(0, 8)}] Sending approval: ${behavior}`);
    await this.sendControlResponse(response);
  }
  async sendControlResponse(response) {
    if (!this.currentRequestId) {
      throw new Error("No pending control request");
    }
    const requestId = this.currentRequestId;
    this.currentRequestId = null;
    const controlMessage = {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response
      }
    };
    await this.writeToStdin(JSON.stringify(controlMessage));
  }
  async writeToStdin(json) {
    if (!this.process || !this.process.stdin) {
      throw new Error("Process stdin not available");
    }
    return new Promise((resolve, reject) => {
      const success = this.process.stdin.write(json + `
`, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
      if (!success) {
        this.process.stdin.once("drain", () => resolve());
      }
    });
  }
  setActivity(activity) {
    if (this.currentActivity === activity)
      return;
    this.currentActivity = activity;
    this.plugin.emit("metadata", {
      sessionId: this.sessionId,
      activity,
      timestamp: new Date
    });
  }
  flushTextBuffer(isComplete = false, outputType = "stdout") {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    if (this.textBuffer) {
      this.plugin.log(`[${this.sessionId.slice(0, 8)}] Flushing buffer: outputType=${outputType}, length=${this.textBuffer.length}, isComplete=${isComplete}`);
      this.plugin.emit("output", {
        sessionId: this.sessionId,
        content: this.textBuffer,
        isComplete,
        outputType,
        timestamp: new Date
      });
      this.textBuffer = "";
    }
  }
  scheduleBatchFlush(outputType = "stdout") {
    if (outputType !== this.currentOutputType && this.textBuffer) {
      this.plugin.log(`[${this.sessionId.slice(0, 8)}] Output type changing: ${this.currentOutputType} -> ${outputType}, flushing existing buffer`);
      this.flushTextBuffer(false, this.currentOutputType);
      this.currentOutputType = outputType;
    }
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }
    this.batchTimer = setTimeout(() => {
      this.flushTextBuffer(false, this.currentOutputType);
    }, this.BATCH_DELAY);
  }
  async start() {
    this.plugin.log(`[${this.sessionId.slice(0, 8)}] Starting Claude SDK process...`);
    return new Promise((resolve, reject) => {
      const args = [
        "--output-format",
        "stream-json",
        "--verbose",
        "--input-format",
        "stream-json",
        "--include-partial-messages",
        "--permission-prompt-tool",
        "stdio"
      ];
      const maxTokens = this.getMaxThinkingTokens();
      if (maxTokens > 0) {
        args.push("--max-thinking-tokens", maxTokens.toString());
        this.plugin.log(`[${this.sessionId.slice(0, 8)}] Extended thinking enabled: ${maxTokens} tokens`);
      }
      const env = {
        ...process.env,
        ...this.config.options?.env,
        CLAUDE_CODE_ENTRYPOINT: "sdk-ts"
      };
      this.process = spawn(this.config.cliPath, args, {
        cwd: this.config.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
      const rl = createInterface({
        input: this.process.stdout,
        crlfDelay: true
      });
      let lineBuffer = "";
      this.process.stdout?.on("data", (data) => {
        lineBuffer += data.toString();
        const lines = lineBuffer.split(`
`);
        lineBuffer = lines.pop() || "";
        for (const line of lines) {
          if (line.trim()) {
            this.processLine(line);
          }
        }
      });
      this.process.stderr?.on("data", (data) => {
        const str = data.toString();
        if (str.trim() && !str.includes("CPU lacks AVX")) {
          this.plugin.log(`[${this.sessionId.slice(0, 8)}] stderr: ${str.trim()}`);
        }
      });
      this.process.on("close", (code) => {
        this.processExited = true;
        this.stdinReady = false;
        this.process = null;
        this.status = "offline";
        if (lineBuffer.trim()) {
          this.processLine(lineBuffer);
        }
        for (const [requestId, pending] of this.pendingControlRequests) {
          pending.reject(new Error("Process exited"));
        }
        this.pendingControlRequests.clear();
        this.plugin.log(`[${this.sessionId.slice(0, 8)}] Exit: ${code}`);
        resolve();
      });
      this.process.on("error", (err) => {
        this.processExited = true;
        this.stdinReady = false;
        this.process = null;
        this.status = "error";
        this.plugin.emit("error", {
          sessionId: this.sessionId,
          error: err.message,
          fatal: true
        });
        reject(err);
      });
      setTimeout(() => {
        if (!this.processExited) {
          this.stdinReady = true;
          this.plugin.log(`[${this.sessionId.slice(0, 8)}] Ready`);
          this.emit("ready");
          resolve();
        }
      }, 500);
    });
  }
  debugLog(direction, data) {
    if (!this.debugLogPath)
      return;
    const logEntry = {
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      direction,
      ...data
    };
    try {
      appendFileSync(this.debugLogPath, JSON.stringify(logEntry) + `
`);
    } catch (e) {}
  }
  processLine(line) {
    try {
      const message2 = JSON.parse(line);
      this.plugin.debug(`[${this.sessionId.slice(0, 8)}] \u2190 ${message2.type}`);
      this.debugLog("RECEIVED", { type: message2.type, raw: line });
      switch (message2.type) {
        case "system":
          this.handleSystemMessage(message2);
          break;
        case "stream_event":
          this.handleStreamEvent(message2);
          break;
        case "assistant":
          this.handleAssistantMessage(message2);
          break;
        case "user":
          this.handleUserMessage(message2);
          break;
        case "control_request":
          this.handleControlRequest(message2);
          break;
        case "control_response":
          this.handleControlResponse(message2);
          break;
        case "keep_alive":
          break;
      }
    } catch (e) {
      this.plugin.log(`[${this.sessionId.slice(0, 8)}] Failed to parse: ${line.slice(0, 100)}`);
      this.plugin.debug(`[${this.sessionId.slice(0, 8)}] Error: ${e}`);
      this.debugLog("ERROR", { error: String(e), line: line.slice(0, 500) });
    }
  }
  handleSystemMessage(message2) {
    this.plugin.log(`[${this.sessionId.slice(0, 8)}] System: model=${message2.model}, tools=${message2.tools.length}`);
    this.plugin.emit("output", {
      sessionId: this.sessionId,
      content: `\u2713 Connected (${message2.model}, ${message2.tools.length} tools)`,
      isComplete: false,
      outputType: "info",
      timestamp: new Date
    });
  }
  handleStreamEvent(message2) {
    const event = message2.event;
    switch (event.type) {
      case "message_start":
        this.seenToolUses.clear();
        this.currentTool = null;
        this.currentToolInput = {};
        this.currentToolUseId = null;
        this.currentThinking = "";
        this.currentOutputType = "stdout";
        this.setActivity("Thinking");
        this.isThinking = true;
        break;
      case "content_block_start":
        const block = event.content_block;
        if (block.type === "tool_use") {
          this.flushTextBuffer(true);
          this.currentOutputType = "stdout";
          this.currentTool = block.name;
          this.currentToolUseId = block.id;
          this.currentToolInput = {};
          this.isThinking = false;
          const activity = this.getActivityForTool(block.name);
          this.setActivity(activity);
          this.plugin.emit("status", {
            sessionId: this.sessionId,
            status: "working",
            currentTool: block.name
          });
        } else if (block.type === "thinking") {
          this.flushTextBuffer(true);
          this.currentOutputType = "thinking";
          this.isThinking = true;
          this.setActivity("Thinking");
          this.plugin.log(`[${this.sessionId.slice(0, 8)}] Thinking block started, outputType set to 'thinking'`);
          this.plugin.emit("status", {
            sessionId: this.sessionId,
            status: "thinking"
          });
        } else if (block.type === "text") {
          this.flushTextBuffer(true);
          this.currentOutputType = "stdout";
        }
        break;
      case "content_block_delta":
        const delta = event.delta;
        if (delta.type === "text_delta" && delta.text) {
          if (!this.isThinking && this.currentActivity !== "Thinking") {
            this.isThinking = true;
            this.setActivity("Thinking");
          }
          this.currentContent += delta.text;
          this.textBuffer += delta.text;
          this.scheduleBatchFlush("stdout");
        } else if (delta.type === "thinking_delta" && delta.thinking) {
          this.currentThinking += delta.thinking;
          this.textBuffer += delta.thinking;
          this.scheduleBatchFlush("thinking");
          this.plugin.log(`[${this.sessionId.slice(0, 8)}] Thinking delta received: ${delta.thinking.slice(0, 50)}... (total: ${this.currentThinking.length} chars)`);
          this.debugLog("THINKING_DELTA", {
            content: delta.thinking,
            accumulatedLength: this.currentThinking.length
          });
        } else if (delta.type === "input_json_delta" && delta.partial_json) {
          if (this.currentTool) {
            try {
              const parsed = JSON.parse(delta.partial_json);
              Object.assign(this.currentToolInput, parsed);
            } catch {}
          }
        }
        break;
      case "content_block_stop":
        if (event.content_block?.type === "tool_use") {
          const toolId = event.content_block.id;
          this.seenToolUses.add(toolId);
          if (this.currentTool === "Edit" || this.currentTool === "MultiEdit") {
            const toolPreview = this.formatToolInput(this.currentTool, this.currentToolInput);
            const editPath = this.currentToolInput.path || this.currentToolInput.filePath || "file";
            this.plugin.emit("output", {
              sessionId: this.sessionId,
              content: `**Editing:** ${editPath}
\`\`\`diff
${toolPreview}
\`\`\``,
              isComplete: false,
              outputType: "edit",
              structuredData: {
                edit: {
                  filePath: editPath,
                  oldContent: this.currentToolInput.oldText,
                  newContent: this.currentToolInput.newText,
                  diff: toolPreview
                }
              },
              timestamp: new Date
            });
            this.debugLog("EMITTED", {
              type: "edit",
              isComplete: false,
              tool: this.currentTool,
              contentPreview: `**Editing:** ${this.currentToolInput.path || "file"}`
            });
          } else {
            const toolPreview = this.formatToolInput(this.currentTool, this.currentToolInput);
            this.plugin.emit("output", {
              sessionId: this.sessionId,
              content: `[${this.currentTool}]
\`\`\`
${toolPreview}
\`\`\``,
              isComplete: false,
              outputType: "tool_use",
              structuredData: {
                tool: {
                  name: this.currentTool,
                  input: this.currentToolInput
                }
              },
              timestamp: new Date
            });
            this.debugLog("EMITTED", {
              type: "tool_use",
              isComplete: false,
              tool: this.currentTool,
              input: this.currentToolInput,
              contentPreview: `[${this.currentTool}]`
            });
          }
        } else if (event.content_block?.type === "thinking") {
          this.flushTextBuffer(true, "thinking");
          this.currentOutputType = "stdout";
        }
        break;
      case "message_delta":
        if (event.usage) {
          this.plugin.emit("metadata", {
            sessionId: this.sessionId,
            tokens: event.usage.input_tokens + event.usage.output_tokens,
            timestamp: new Date
          });
        }
        if (event.delta?.stop_reason === "tool_use") {
          this.status = "waiting";
          this.setActivity("Waiting for tool results");
          this.plugin.emit("status", {
            sessionId: this.sessionId,
            status: "waiting"
          });
        }
        break;
      case "message_stop":
        this.flushTextBuffer(true, this.currentOutputType);
        this.status = "idle";
        this.currentThinking = "";
        this.isThinking = false;
        this.currentOutputType = "stdout";
        this.setActivity(null);
        this.plugin.emit("status", {
          sessionId: this.sessionId,
          status: "idle"
        });
        break;
    }
  }
  getActivityForTool(toolName) {
    const activityMap = {
      Task: "Delegating to agent",
      Bash: "Running command",
      Edit: "Editing file",
      Write: "Writing file",
      Read: "Reading file",
      Glob: "Searching files",
      Grep: "Searching content",
      AskUserQuestion: "Waiting for input",
      MultiEdit: "Editing files",
      DirectoryTree: "Listing directory"
    };
    return activityMap[toolName] || `Using ${toolName}`;
  }
  handleAssistantMessage(message2) {
    this.debugLog("ASSISTANT_MESSAGE", {
      messageId: message2.message.id,
      contentTypes: message2.message.content.map((c) => c.type),
      hasThinkingMetadata: !!message2.thinkingMetadata,
      todosCount: message2.todos?.length || 0,
      fullMessage: message2
    });
    for (const content of message2.message.content) {
      if (content.type === "thinking") {
        this.plugin.emit("output", {
          sessionId: this.sessionId,
          content: content.thinking,
          isComplete: true,
          outputType: "thinking",
          timestamp: new Date
        });
        this.debugLog("EMITTED", {
          type: "thinking",
          contentPreview: content.thinking.slice(0, 200),
          isComplete: true
        });
      }
    }
    if (message2.todos && message2.todos.length > 0) {
      const todoContent = message2.todos.map((todo) => {
        const status = todo.status === "completed" ? "\u2705" : todo.status === "in_progress" ? "\uD83D\uDD04" : "\u23F3";
        return `${status} ${todo.content}`;
      }).join(`
`);
      this.plugin.emit("output", {
        sessionId: this.sessionId,
        content: todoContent,
        isComplete: true,
        outputType: "info",
        timestamp: new Date
      });
      this.debugLog("EMITTED", {
        type: "info",
        contentType: "todos",
        todosCount: message2.todos.length,
        content: todoContent
      });
    }
    this.plugin.debug(`[${this.sessionId.slice(0, 8)}] Assistant message processed: ${message2.message.id}`);
  }
  formatToolInput(toolName, input) {
    switch (toolName) {
      case "Bash":
        return `$ ${input.command}`;
      case "Edit":
        const editPath = input.path || input.filePath || "file";
        if (input.oldText && input.newText) {
          const diff = this.createUnifiedDiff(editPath, input.oldText, input.newText);
          return diff;
        } else if (input.diff) {
          return input.diff;
        } else {
          return `Edit ${editPath}`;
        }
      case "Write":
        const writePath = input.path || input.filePath || "unknown";
        return `Write ${writePath}
\`\`\`
${input.content?.slice(0, 500)}${input.content && input.content.length > 500 ? "..." : ""}
\`\`\``;
      case "Read":
        const readPath = input.path || input.file_path || input.filePath || "unknown";
        return `Read ${readPath}`;
      case "Glob":
        return `Glob: ${input.pattern}`;
      case "Grep":
        return `Grep: ${input.pattern}`;
      case "AskUserQuestion":
        return `Question: ${input.question}`;
      default:
        const keys = Object.keys(input).slice(0, 3);
        return keys.map((k) => `${k}=${JSON.stringify(input[k]).slice(0, 30)}`).join(", ");
    }
  }
  createUnifiedDiff(filePath, oldText, newText) {
    const lines = [];
    const oldLines = oldText.split(`
`);
    const newLines = newText.split(`
`);
    lines.push(`--- a/${filePath}`);
    lines.push(`+++ b/${filePath}`);
    const maxLines = Math.max(oldLines.length, newLines.length);
    let oldLineNum = 1;
    let newLineNum = 1;
    for (let i = 0;i < maxLines; i++) {
      const oldLine = oldLines[i] || "";
      const newLine = newLines[i] || "";
      if (oldLine === newLine) {
        lines.push(` ${oldLine}`);
        oldLineNum++;
        newLineNum++;
      } else {
        if (oldLine) {
          lines.push(`-${oldLine}`);
          oldLineNum++;
        }
        if (newLine) {
          lines.push(`+${newLine}`);
          newLineNum++;
        }
      }
    }
    return lines.join(`
`);
  }
  stripLineNumbers(content) {
    return content.split(`
`).map((line) => {
      const match = line.match(/^\s*\d+\u2192(.*)$/);
      return match ? match[1] : line;
    }).join(`
`);
  }
  handleUserMessage(message2) {
    this.debugLog("USER_MESSAGE", {
      contentTypes: message2.message.content.map((c) => c.type),
      toolResultsCount: message2.message.content.filter((c) => c.type === "tool_result").length
    });
    for (const content of message2.message.content) {
      if (content.type === "tool_result") {
        const toolResult = content;
        if (this.currentTool && toolResult.tool_use_id === this.currentToolUseId) {
          const toolPreview = this.formatToolInput(this.currentTool, this.currentToolInput);
          let resultContent = String(toolResult.content || "");
          if (this.currentTool === "Read") {
            resultContent = this.stripLineNumbers(resultContent);
          }
          resultContent = resultContent.slice(0, 2000);
          if (toolResult.is_error) {
            this.plugin.emit("output", {
              sessionId: this.sessionId,
              content: `**[${this.currentTool}]**
\`\`\`
${toolPreview}
\`\`\`

**Error:**
\`\`\`
${resultContent}
\`\`\``,
              isComplete: true,
              outputType: "tool_result",
              structuredData: {
                tool: {
                  name: this.currentTool,
                  input: this.currentToolInput,
                  result: resultContent,
                  isError: true
                }
              },
              timestamp: new Date
            });
            this.debugLog("EMITTED", {
              type: "tool_result",
              isComplete: true,
              isError: true,
              tool: this.currentTool,
              resultPreview: resultContent.slice(0, 200)
            });
          } else {
            this.plugin.emit("output", {
              sessionId: this.sessionId,
              content: `**[${this.currentTool}]**
\`\`\`
${toolPreview}
\`\`\`

**Result:**
\`\`\`
${resultContent}
\`\`\``,
              isComplete: true,
              outputType: "tool_result",
              structuredData: {
                tool: {
                  name: this.currentTool,
                  input: this.currentToolInput,
                  result: resultContent
                }
              },
              timestamp: new Date
            });
            this.debugLog("EMITTED", {
              type: "tool_result",
              isComplete: true,
              isError: false,
              tool: this.currentTool,
              resultPreview: resultContent.slice(0, 200)
            });
          }
          this.currentTool = null;
          this.currentToolInput = {};
          this.currentToolUseId = null;
        } else {
          const resultContent = String(toolResult.content || "").slice(0, 2000);
          this.plugin.emit("output", {
            sessionId: this.sessionId,
            content: `[Tool Result] ${resultContent}`,
            isComplete: true,
            outputType: "tool_result",
            timestamp: new Date
          });
          this.debugLog("EMITTED", {
            type: "tool_result",
            isComplete: true,
            unmatched: true,
            toolUseId: toolResult.tool_use_id,
            currentToolUseId: this.currentToolUseId,
            resultPreview: resultContent.slice(0, 200)
          });
        }
      }
    }
    this.plugin.debug(`[${this.sessionId.slice(0, 8)}] User message: ${message2.uuid}`);
  }
  async handleControlRequest(message2) {
    const { request_id, request } = message2;
    this.plugin.debug(`[${this.sessionId.slice(0, 8)}] Control request: ${request.subtype}`);
    if (request.subtype === "can_use_tool") {
      this.currentRequestId = request_id;
      if (request.tool_name === "AskUserQuestion") {
        await this.handleAskUserQuestion(request_id, request);
        return;
      }
      this.status = "waiting";
      const options = [
        { number: "1", label: "Yes" },
        { number: "2", label: "No" },
        { number: "3", label: "Always" }
      ];
      const context = this.buildToolContext(request.tool_name, request.input);
      this.plugin.emit("approval", {
        sessionId: this.sessionId,
        tool: request.tool_name,
        context,
        options,
        detectedAt: new Date
      });
    } else {
      const errorMessage = {
        type: "control_response",
        response: {
          subtype: "error",
          request_id,
          error: `Unsupported control request subtype: ${request.subtype}`
        }
      };
      await this.writeToStdin(JSON.stringify(errorMessage));
    }
  }
  async handleAskUserQuestion(requestId, request) {
    const fs = __require("fs");
    const debugDir = "/tmp/claude-sdk-debug";
    try {
      fs.mkdirSync(debugDir, { recursive: true });
    } catch (e) {}
    const debugPath = `${debugDir}/${this.sessionId.slice(0, 8)}-ask-user-question.json`;
    try {
      fs.writeFileSync(debugPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        sessionId: this.sessionId,
        requestId,
        fullRequest: request
      }, null, 2) + `
`);
      console.log(`[${this.sessionId.slice(0, 8)}] WROTE FULL CONTROL REQUEST TO: ${debugPath}`);
    } catch (e) {
      console.error("Failed to write debug file:", e);
    }
    let questionsArray = [];
    if (Array.isArray(request.input)) {
      questionsArray = request.input;
    } else if (request.input && Array.isArray(request.input.questions)) {
      questionsArray = request.input.questions;
    } else if (request.input && request.input.question) {
      questionsArray = [request.input];
    }
    console.log(`[${this.sessionId.slice(0, 8)}] Parsed ${questionsArray.length} questions from input`);
    if (questionsArray.length === 0) {
      this.plugin.log(`[${this.sessionId.slice(0, 8)}] Invalid AskUserQuestion format - no questions found`);
      return;
    }
    this.pendingQuestion = {
      input: request.input,
      questions: questionsArray,
      allAnswers: [],
      currentQuestionIndex: 0,
      multiSelect: questionsArray[0]?.multiSelect || false
    };
    await this.askNextQuestion();
  }
  async askNextQuestion() {
    const pendingQuestion = this.pendingQuestion;
    const questionIndex = pendingQuestion.currentQuestionIndex;
    const questionsArray = pendingQuestion.questions;
    if (questionIndex >= questionsArray.length) {
      await this.sendAllAnswers();
      return;
    }
    const currentQuestion = questionsArray[questionIndex];
    const question = currentQuestion.question || "Please provide input:";
    const options = currentQuestion.options || [];
    const multiSelect = currentQuestion.multiSelect || false;
    const header = currentQuestion.header || null;
    this.plugin.log(`[${this.sessionId.slice(0, 8)}] Question details:`, JSON.stringify({
      questionIndex: questionIndex + 1,
      totalQuestions: questionsArray.length,
      question,
      optionsCount: options.length,
      multiSelect,
      rawMultiSelect: currentQuestion.multiSelect
    }));
    const processedOptions = options.map((opt, idx) => {
      if (typeof opt === "string") {
        return { label: opt, value: opt };
      }
      return {
        ...opt,
        value: opt.value || opt.label || `option${idx}`
      };
    });
    const optionLabels = options.map((opt, idx) => {
      if (typeof opt === "string")
        return opt;
      return opt.label || opt.value || `Option ${idx + 1}`;
    });
    let contextText = header ? `**${header}**

${question}` : question;
    if (questionsArray.length > 1) {
      contextText += `

*(Question ${questionIndex + 1} of ${questionsArray.length})*`;
    }
    if (options.length > 0) {
      const optionDescriptions = options.map((o, idx) => {
        if (typeof o === "string")
          return `${idx + 1}. ${o}`;
        return `${idx + 1}. ${o.label || o.value || "Option"}`;
      }).join(`
`);
      contextText += `

${optionDescriptions}`;
    }
    this.plugin.emit("approval", {
      sessionId: this.sessionId,
      tool: "AskUserQuestion",
      context: contextText,
      options: optionLabels,
      detectedAt: new Date,
      isMultiSelect: multiSelect,
      hasOther: true
    });
    this.plugin.log(`[${this.sessionId.slice(0, 8)}] Emitting approval event with flags:`, JSON.stringify({
      isMultiSelect: multiSelect,
      hasOther: true,
      optionsCount: optionLabels.length
    }));
    if (questionIndex === 0) {
      this.currentRequestId = this.currentRequestId || null;
    }
    pendingQuestion.currentOptions = processedOptions;
    pendingQuestion.currentMultiSelect = multiSelect;
    this.plugin.log(`[${this.sessionId.slice(0, 8)}] Waiting for answer to question ${questionIndex + 1}/${questionsArray.length}`);
  }
  async sendAllAnswers() {
    const pendingQuestion = this.pendingQuestion;
    const originalInput = pendingQuestion.input;
    const questionsArray = pendingQuestion.questions;
    const answers = pendingQuestion.allAnswers;
    const questionsCount = questionsArray.length;
    this.plugin.log(`[${this.sessionId.slice(0, 8)}] All ${questionsCount} questions answered, sending:`, JSON.stringify(answers));
    const updatedInput = {};
    if (Array.isArray(originalInput)) {
      updatedInput.questions = questionsArray.map((q, idx) => ({
        ...q,
        answer: answers[idx]
      }));
    } else if (originalInput.questions && Array.isArray(originalInput.questions)) {
      updatedInput.questions = questionsArray.map((q, idx) => ({
        ...q,
        answer: answers[idx]
      }));
    } else if (originalInput.question) {
      updatedInput.answer = answers[0];
    }
    const response = {
      behavior: "allow",
      updatedInput
    };
    const controlMessage = {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: this.currentRequestId,
        response
      }
    };
    this.plugin.log(`[${this.sessionId.slice(0, 8)}] Sending control_response with updatedInput:`, JSON.stringify(updatedInput));
    const jsonString = JSON.stringify(controlMessage);
    console.log(`[${this.sessionId.slice(0, 8)}] WRITING TO STDIN:`, JSON.stringify(controlMessage, null, 2));
    const fs = __require("fs");
    const debugPath = `/tmp/claude-sdk-debug/${this.sessionId.slice(0, 8)}-control-response.json`;
    try {
      fs.writeFileSync(debugPath, JSON.stringify(controlMessage, null, 2) + `
`);
    } catch (e) {
      console.error("Failed to write debug file:", e);
    }
    await this.writeToStdin(jsonString);
    delete this.pendingQuestion;
  }
  buildToolContext(toolName, input) {
    switch (toolName) {
      case "Bash":
        return `Command: ${input.command}`;
      case "Edit":
      case "Write":
        return `File: ${input.path}`;
      case "Read":
        return `Read: ${input.path}`;
      case "Glob":
        return `Pattern: ${input.pattern}`;
      case "Grep":
        return `Search: ${input.pattern}`;
      default:
        return JSON.stringify(input).slice(0, 200);
    }
  }
  getMaxThinkingTokens() {
    if (this.config.options?.maxThinkingTokens !== undefined) {
      return this.config.options.maxThinkingTokens;
    }
    const level = this.config.options?.thinkingLevel || "default_on";
    if (level === "off") {
      return 0;
    }
    return 31999;
  }
  handleControlResponse(message2) {
    const { request_id, response } = message2;
    const pending = this.pendingControlRequests.get(request_id);
    if (pending) {
      if (response.subtype === "success") {
        pending.resolve(response.response);
      } else {
        pending.reject(new Error(response.error || "Control request failed"));
      }
      this.pendingControlRequests.delete(request_id);
    }
  }
  async interrupt() {
    if (this.process && !this.processExited) {
      this.plugin.log(`[${this.sessionId.slice(0, 8)}] Sending interrupt`);
      const controlMessage = {
        type: "control_request",
        request_id: randomUUID(),
        request: {
          subtype: "hook_callback"
        }
      };
      await this.writeToStdin(JSON.stringify(controlMessage));
      this.status = "idle";
    }
  }
  async close() {
    if (this.process && !this.processExited) {
      this.plugin.log(`[${this.sessionId.slice(0, 8)}] Closing`);
      this.process.kill("SIGTERM");
      setTimeout(() => {
        if (this.process && !this.processExited) {
          this.process.kill("SIGKILL");
        }
      }, 5000);
    }
    this.process = null;
    this.processExited = true;
    this.stdinReady = false;
    this.status = "offline";
    for (const pending of this.pendingControlRequests.values()) {
      pending.reject(new Error("Session closed"));
    }
    this.pendingControlRequests.clear();
  }
}

class ClaudeSDKPlugin extends BasePlugin {
  name = "ClaudeSDKPlugin";
  type = "claude-sdk";
  isPersistent = true;
  sessions = new Map;
  async initialize() {
    await super.initialize();
    this.log("Initialized (Claude SDK mode with bidirectional JSON protocol)");
  }
  async createSession(config) {
    const session = new ClaudeSDKSession(config, this);
    await session.start();
    this.sessions.set(config.sessionId, session);
    this.log(`Created session: ${config.sessionId.slice(0, 8)} in ${config.cwd}`);
    await new Promise((resolve) => {
      if (session.isReady) {
        resolve();
      } else {
        session.once("ready", () => resolve());
      }
    });
    return session;
  }
  async destroySession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      await session.close();
      this.sessions.delete(sessionId);
    }
  }
  getSessions() {
    return Array.from(this.sessions.values());
  }
}
export {
  ClaudeSDKPlugin
};
