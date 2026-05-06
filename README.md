```
ftp-web/
├── src/
│   ├── server/
│   │   ├── index.ts                 # Bun.serve entry (Hono app + WS handler)
│   │   ├── app.ts                   # Hono app setup, middleware, route mounting
│   │   │
│   │   ├── ws/
│   │   │   ├── index.ts             # createBunWebSocket + upgrade route
│   │   │   ├── handler.ts           # onOpen/onMessage/onClose logic
│   │   │   ├── session.ts           # Per-socket FTP session (WSContext bound)
│   │   │   └── protocol.ts          # Message parsing/validation (Zod)
│   │   │
│   │   ├── ftp/
│   │   │   ├── ftp-client.ts        # Your existing FTP client
│   │   │   └── session-manager.ts   # Map<wsId, FtpClient> lifecycle
│   │   │
│   │   ├── routes/
│   │   │   ├── index.ts             # Route aggregator
│   │   │   ├── health.ts            # GET /health
│   │   │   ├── upload.ts            # POST /api/upload/:sessionId
│   │   │   └── download.ts          # GET  /api/download/:sessionId
│   │   │
│   │   └── middleware/
│   │       ├── logger.ts            # Hono logger wrapper
│   │       ├── auth.ts              # Session token validation
│   │       └── error.ts             # Centralized error handler
│   │
│   ├── client/
│   │   ├── index.html
│   │   ├── main.ts
│   │   ├── ws-client.ts             # Typed WS client + reconnect
│   │   ├── api.ts                   # fetch() wrappers for upload/download
│   │   ├── components/
│   │   │   ├── ConnectionForm.ts
│   │   │   ├── FileBrowser.ts
│   │   │   ├── LocalBrowser.ts
│   │   │   ├── TransferQueue.ts
│   │   │   ├── Terminal.ts
│   │   │   └── StatusBar.ts
│   │   ├── state/
│   │   │   └── store.ts
│   │   └── styles/
│   │       └── main.css
│   │
│   └── shared/
│       ├── types.ts                 # FileEntry, TransferState, etc.
│       └── messages.ts              # Zod schemas + inferred WS message types
│
├── public/
│   └── favicon.ico
│
├── tests/
│   ├── ftp-client.test.ts
│   ├── ws-handler.test.ts
│   └── routes.test.ts
│
├── package.json
├── tsconfig.json
├── bunfig.toml
└── README.md
````
