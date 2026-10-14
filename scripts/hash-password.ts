/**
 * Generates the bcrypt hash for ADMIN_PASSWORD_HASH.
 * Usage: npm run hash-password   (password is typed hidden — not stored in shell history)
 */
import bcrypt from 'bcryptjs';
import readline from 'node:readline';

const COST = 12;

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput;
    let muted = false;
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (!muted) write.call(rl, s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

async function main() {
  const password = await askHidden('Admin password: ');
  if (password.length < 10) {
    console.error('Use at least 10 characters.');
    process.exit(1);
  }
  const confirm = await askHidden('Repeat password: ');
  if (confirm !== password) {
    console.error('Passwords do not match.');
    process.exit(1);
  }
  const hash = await bcrypt.hash(password, COST);
  console.log("\nAdd this line to tracker_backend/.env (keep the single quotes — the hash contains '$'):\n");
  console.log(`ADMIN_PASSWORD_HASH='${hash}'`);
}

main();
