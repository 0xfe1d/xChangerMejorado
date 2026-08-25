import { PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash('admin', 10);

  const admin = await prisma.user.upsert({
    where: { email: 'asierdelcidperez@outlook.com' },
    update: {},
    create: {
      email: 'asierdelcidperez@outlook.com',
      name: 'Asier del Cid Pérez',
      passwordHash,
      role: Role.PROPIETARIO,
    },
  });

  console.log(`Administrador supremo creado: ${admin.email} (id: ${admin.id})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
