// Installed as server.js in the packaged dashboard.
async function main() {
  process.env.NODE_ENV = "production"
  process.chdir(__dirname)
  const { config } = require("./.next/required-server-files.json")
  process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(config)

  const { startServer } = await import("./server.mjs")
  const server = await startServer(process.argv.slice(2), {
    ...process.env,
    NAIA_DASHBOARD_PORT: process.env.NAIA_DASHBOARD_PORT || String(Number.parseInt(process.env.PORT, 10) || 3000),
    NAIA_DASHBOARD_HOST: process.env.NAIA_DASHBOARD_HOST || process.env.HOSTNAME || "0.0.0.0",
  })
  const keepAliveTimeout = Number.parseInt(process.env.KEEP_ALIVE_TIMEOUT, 10)
  if (Number.isFinite(keepAliveTimeout) && keepAliveTimeout > 0) server.keepAliveTimeout = keepAliveTimeout
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
