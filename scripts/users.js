/* Manage staff accounts. Run on the server, by the administrator only:

     npm run users -- add <user-id>         create an account (asks for the password)
     npm run users -- reset <user-id>       set a new password (signs that person out)
     npm run users -- remove <user-id>      delete an account (signs that person out)
     npm run users -- list                  show all accounts

   Passwords are typed at a hidden prompt, never on the command line, so they don't
   end up in shell history. */

const readline = require("node:readline");
const users = require("../src/users");

const [command, userId] = process.argv.slice(2);

// Answers are read from a queue of lines, so piped input works as well as typing.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
const lines = rl[Symbol.asyncIterator]();
let hidden = false;
rl._writeToOutput = (text) => { if (!hidden) process.stdout.write(text); };   // no echo while typing a password

async function askHidden(question) {
  process.stdout.write(question);
  hidden = true;
  const { value, done } = await lines.next();
  hidden = false;
  if (process.stdin.isTTY) process.stdout.write("\n");
  if (done) throw new Error("No password was entered. Nothing was changed.");
  return value;
}

async function askNewPassword() {
  const password = await askHidden(`New password (at least ${users.MIN_PASSWORD_LENGTH} characters): `);
  const again = await askHidden("Type it again: ");
  if (password !== again) throw new Error("The passwords didn't match. Nothing was changed.");
  return password;
}

const formatDate = (ms) => new Date(ms).toLocaleString();

async function main() {
  switch (command) {
    case "add": {
      requireId();
      users.validateUserId(userId);
      if (users.getUser(userId)) throw new Error(`There's already an account called "${userId}".`);
      await users.createUser(userId, await askNewPassword());
      console.log(`Created the account "${userId}".`);
      break;
    }
    case "reset": {
      requireId();
      if (!users.getUser(userId)) throw new Error(`There's no account called "${userId}".`);
      await users.setPassword(userId, await askNewPassword());
      console.log(`Set a new password for "${userId}". They've been signed out everywhere.`);
      break;
    }
    case "remove": {
      requireId();
      users.removeUser(userId);
      console.log(`Removed the account "${userId}". They've been signed out everywhere.`);
      break;
    }
    case "list": {
      const all = users.listUsers();
      if (!all.length) console.log("No accounts yet. Add one with: npm run users -- add <user-id>");
      for (const u of all) console.log(`${u.id.padEnd(24)} created ${formatDate(u.createdAt)}   password set ${formatDate(u.passwordChangedAt)}`);
      break;
    }
    default:
      console.log("Usage: npm run users -- add <user-id> | reset <user-id> | remove <user-id> | list");
      process.exitCode = command ? 1 : 0;
  }
}

function requireId() {
  if (!userId) throw new Error(`Give a user ID, for example: npm run users -- ${command} jsmith`);
}

main()
  .catch((err) => { console.error(err.message); process.exitCode = 1; })
  .finally(() => rl.close());
