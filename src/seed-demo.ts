import { prisma } from "./db.js";
import { seedDemo } from "./demo/seed.js";

await seedDemo(prisma);
await prisma.$disconnect();
console.log("Demo accounts ready");
