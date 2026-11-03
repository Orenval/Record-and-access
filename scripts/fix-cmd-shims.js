const fs = require('fs');
const path = require('path');

// On Windows, if the repository path contains special characters like '&',
// npm's default .cmd shims break because `SET dp0=%~dp0` is unquoted.
// This script quotes dp0 in all .cmd shims in node_modules/.bin so commands
// like `npx prisma studio` work properly.
if (process.platform === 'win32') {
  const binDir = path.join(__dirname, '..', 'node_modules', '.bin');
  if (fs.existsSync(binDir)) {
    const files = fs.readdirSync(binDir);
    for (const file of files) {
      if (file.endsWith('.cmd')) {
        const filePath = path.join(binDir, file);
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          if (content.includes('SET dp0=%~dp0')) {
            fs.writeFileSync(filePath, content.replace(/SET dp0=%~dp0/g, 'SET "dp0=%~dp0"'), 'utf8');
          }
        } catch {
          // ignore read/write errors for locked files
        }
      }
    }
  }
}
