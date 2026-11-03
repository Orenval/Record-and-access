require("dotenv/config");
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const bcrypt = require("bcrypt");

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});
const prisma = new PrismaClient({ adapter });

async function main() {
  const email = process.argv[2];
  const password = process.argv[3];
  const fullName = process.argv[4] || (email ? email.split("@")[0] : "Test User");

  if (!email || !password) {
    console.error("Usage: node scripts/create-user.js <email> <password> [fullName]");
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const user = await prisma.user.upsert({
    where: { email },
    update: {
      passwordHash,
      fullName,
    },
    create: {
      email,
      passwordHash,
      fullName,
    },
  });

  console.log(`User created/updated successfully: id=${user.id}, email=${user.email}, fullName=${user.fullName}`);
}

main()
  .catch((e) => {
    console.error("Error creating user:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
