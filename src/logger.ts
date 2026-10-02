const isDebug = () => process.env.DEBUG === "1";

const prefix = (tag: string, color: string) => `${color}${tag}${RESET} `;
const RESET = "\u001b[0m";

const write = (stream: NodeJS.WriteStream, message: string) => {
  stream.write(`${message}\n`);
};

export const Logger = {
  info(message: string) {
    write(process.stdout, `${prefix("·", "\u001b[36m")}${message}`);
  },

  success(message: string) {
    write(process.stdout, `${prefix("✓", "\u001b[32m")}${message}`);
  },

  warn(message: string) {
    write(process.stderr, `${prefix("!", "\u001b[33m")}${message}`);
  },

  error(message: string) {
    write(process.stderr, `${prefix("✗", "\u001b[31m")}${message}`);
  },

  debug(message: string) {
    if (isDebug())
      write(process.stdout, `${prefix("·", "\u001b[90m")}${message}`);
  },

  step(message: string) {
    write(process.stdout, `\n${prefix("▸", "\u001b[35m")}${message}`);
  },
};
