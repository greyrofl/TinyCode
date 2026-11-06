/**
 * Development-only fake Ollama server. It implements just enough of the API to
 * exercise listed models, streaming chat, reasoning output and aborts.
 *
 *   node scripts/mock-ollama.mjs
 *   TINYCODE_OLLAMA_URL=http://127.0.0.1:11435 node dist/cli.js run "hello"
 */
import http from "node:http";

const port = Number(process.env.PORT ?? 11435);

const models = [
  {
    name: "qwen2.5-coder:7b",
    model: "qwen2.5-coder:7b",
    modified_at: new Date().toISOString(),
    size: 4_700_000_000,
    details: { family: "qwen2", parameter_size: "7.6B", quantization_level: "Q4_K_M" },
  },
  {
    name: "llama3.2:3b",
    model: "llama3.2:3b",
    modified_at: new Date().toISOString(),
    size: 2_000_000_000,
    details: { family: "llama", parameter_size: "3.2B", quantization_level: "Q4_K_M" },
  },
  {
    name: "qwen3:1.7b",
    model: "qwen3:1.7b",
    modified_at: new Date().toISOString(),
    size: 1_400_000_000,
    details: { family: "qwen3", parameter_size: "1.7B", quantization_level: "Q4_K_M" },
  },
];
let running = null;

function sendJson(response, value) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/api/version") {
    sendJson(response, { version: "0.9.0-mock" });
    return;
  }

  if (request.method === "GET" && request.url === "/api/tags") {
    sendJson(response, { models });
    return;
  }

  if (request.method === "GET" && request.url === "/api/ps") {
    sendJson(response, { models: running ? [running] : [] });
    return;
  }

  if (request.method === "POST" && request.url === "/api/show") {
    let body = "";
    for await (const chunk of request) body += chunk;
    const selected = models.find((model) => model.name === JSON.parse(body).model);
    if (!selected) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "model not found" }));
      return;
    }
    const thinking = selected.details.family === "qwen3";
    sendJson(response, {
      details: selected.details,
      capabilities: thinking ? ["completion", "thinking"] : ["completion"],
      thinking: { values: thinking ? [false, true] : [false], default: thinking },
      model_info: { [`${selected.details.family}.context_length`]: 32768 },
    });
    return;
  }

  if (request.method === "POST" && request.url === "/api/generate") {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    const selected = models.find((model) => model.name === payload.model);
    if (!selected) { response.writeHead(404); response.end(JSON.stringify({ error: "model not found" })); return; }
    const context = Number(payload.options?.num_ctx) || 8192;
    running = { name: selected.name, model: selected.name, size: selected.size + context * 32_768, size_vram: selected.size, context_length: context };
    sendJson(response, { model: selected.name, response: "", done: true, done_reason: "load" });
    return;
  }

  if (request.method === "POST" && request.url === "/api/chat") {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    const last = payload.messages?.at(-1)?.content ?? "";
    const model = payload.model ?? "mock";
    const selected = models.find((item) => item.name === model);
    if (selected) {
      const context = Number(payload.options?.num_ctx) || 8192;
      running = { name: selected.name, model: selected.name, size: selected.size + context * 32_768, size_vram: selected.size, context_length: context };
    }
    const hasObservation = payload.messages?.some(
      (message) => message.role === "user" && message.content.startsWith("[Observation:"),
    );

    let answer;
    let thinking = "";
    if (/compress a coding-agent session/i.test(payload.messages?.[0]?.content ?? "")) {
      answer =
        "## Goal\n- Continue the current coding task.\n\n" +
        "## Project and code state\n- Older mock turns were compacted.\n\n" +
        "## Next step\n- Continue from recent messages.\n";
    } else if (/run command/i.test(last) && !hasObservation) {
      answer =
        "I will run a small verification command.\n" +
        '<tool_call>{"name":"execute_command","arguments":{"command":"node -e \\\"console.log(6*7)\\\""}}</tool_call>\n';
    } else if (/list files/i.test(last) && !hasObservation) {
      answer =
        "I will inspect the working directory.\n" +
        '<tool_call>{"name":"list_dir","arguments":{"path":"."}}</tool_call>\n';
    } else if (hasObservation) {
      answer = "Done: I inspected the working directory and the tool result is shown above.\n";
    } else if (/think separately/i.test(last)) {
      thinking = payload.think === false ? "" : "I should keep this reasoning off stdout. ";
      answer = "The answer stream is separate.\n";
    } else {
      answer = `**${model}** says:\n\n> ${last}\n\n\`\`\`js\nconsole.log("hello from tinycode")\n\`\`\`\n\n- one\n- two\n`;
    }

    response.writeHead(200, { "content-type": "application/x-ndjson" });
    const words = answer.split(/(\s+)/).filter(Boolean);
    let index = 0;

    const timer = setInterval(() => {
      if (thinking) {
        const chunk = thinking;
        thinking = "";
        response.write(`${JSON.stringify({ message: { role: "assistant", thinking: chunk }, done: false })}\n`);
        return;
      }
      if (index < words.length) {
        const text = words[index++];
        response.write(`${JSON.stringify({ message: { role: "assistant", content: text }, done: false })}\n`);
        return;
      }
      response.write(
        `${JSON.stringify({
          done: true,
          done_reason: "stop",
          prompt_eval_count: 16,
          eval_count: 64,
          eval_duration: 2_000_000_000,
        })}\n`,
      );
      clearInterval(timer);
      response.end();
    }, 15);

    response.on("close", () => clearInterval(timer));
    return;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not found" }));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock ollama listening on http://127.0.0.1:${port}`);
});
