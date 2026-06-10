const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const API_ROOT = path.join(ROOT, "api-handlers");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);

    if (requestUrl.pathname.startsWith("/api/")) {
      return await serveApiRoute(req, res, requestUrl);
    }

    if (req.method === "GET") {
      return serveStatic(requestUrl.pathname, res);
    }

    sendJson(res, 405, { message: "Method not allowed." });
  } catch (error) {
    sendJson(res, 500, { message: error.message || "Internal server error." });
  }
});

server.listen(PORT, () => {
  console.log(`Aurum Quant AI running at http://localhost:${PORT}`);
});

async function serveApiRoute(nodeReq, nodeRes, requestUrl) {
  const relativeRoute = requestUrl.pathname.replace(/^\/api\//, "");
  const filePath = path.join(API_ROOT, `${relativeRoute}.js`);
  const normalizedPath = path.normalize(filePath);

  if (!normalizedPath.startsWith(API_ROOT) || !fs.existsSync(normalizedPath)) {
    return sendJson(nodeRes, 404, { message: "API route not found." });
  }

  delete require.cache[require.resolve(normalizedPath)];
  const handler = require(normalizedPath);

  if (typeof handler !== "function") {
    return sendJson(nodeRes, 500, { message: "Invalid API handler export." });
  }

  nodeReq.query = Object.fromEntries(requestUrl.searchParams.entries());
  nodeReq.body = await readJsonBody(nodeReq);

  const responseAdapter = createResponseAdapter(nodeRes);
  await handler(nodeReq, responseAdapter);

  if (!responseAdapter.finished) {
    responseAdapter.end();
  }
}

function createResponseAdapter(nodeRes) {
  let statusCode = 200;
  let finished = false;

  return {
    get finished() {
      return finished;
    },
    status(code) {
      statusCode = Number(code) || 200;
      return this;
    },
    setHeader(name, value) {
      nodeRes.setHeader(name, value);
      return this;
    },
    json(payload) {
      if (finished) return this;
      if (!nodeRes.headersSent) {
        nodeRes.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
      }
      nodeRes.end(JSON.stringify(payload));
      finished = true;
      return this;
    },
    send(payload) {
      if (finished) return this;
      if (!nodeRes.headersSent) {
        nodeRes.writeHead(statusCode);
      }
      nodeRes.end(payload);
      finished = true;
      return this;
    },
    end(payload = "") {
      if (finished) return this;
      if (!nodeRes.headersSent) {
        nodeRes.writeHead(statusCode);
      }
      nodeRes.end(payload);
      finished = true;
      return this;
    },
  };
}

function serveStatic(requestPath, res) {
  const safePath = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = path.join(ROOT, safePath);
  const normalizedPath = path.normalize(filePath);

  if (!normalizedPath.startsWith(ROOT)) {
    return sendJson(res, 403, { message: "Forbidden path." });
  }

  if (!fs.existsSync(normalizedPath) || fs.statSync(normalizedPath).isDirectory()) {
    return sendJson(res, 404, { message: "File not found." });
  }

  const extension = path.extname(normalizedPath).toLowerCase();
  const contentType = MIME_TYPES[extension] || "application/octet-stream";

  res.writeHead(200, { "Content-Type": contentType });
  fs.createReadStream(normalizedPath).pipe(res);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  if (req.method === "GET" || req.method === "HEAD") {
    return {};
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}
