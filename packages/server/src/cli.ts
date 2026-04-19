import { Command } from "commander"
import { startServer } from "./server.js"

const program = new Command()

program
  .name("naia-adk")
  .description("Naia ADK backend server")
  .version("0.1.0")

program
  .command("serve")
  .description("Start the ADK backend server")
  .option("-p, --port <port>", "Port number", "3141")
  .option("-h, --host <host>", "Host", "localhost")
  .option("-r, --root <root>", "ADK workspace root", process.cwd())
  .action(async (opts) => {
    console.log(`Starting Naia ADK server on ${opts.host}:${opts.port}`)
    console.log(`Workspace root: ${opts.root}`)
    await startServer({
      root: opts.root,
      port: parseInt(opts.port, 10),
      host: opts.host,
    })
  })

program.parse()
