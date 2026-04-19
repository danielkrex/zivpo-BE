import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

async function main() {
  const email = process.env.SUPERUSER_EMAIL
  const password = process.env.SUPERUSER_PASSWORD

  if (!email || !password) {
    throw new Error('SUPERUSER_EMAIL and SUPERUSER_PASSWORD must be set')
  }

  const existing = await prisma.admin.findUnique({ where: { email } })
  if (existing) {
    console.log('Superuser already exists:', email)
    return
  }

  const passwordHash = await bcrypt.hash(password, 12)
  await prisma.admin.create({
    data: {
      name: 'Superuser',
      email,
      passwordHash,
      isSuperuser: true
    }
  })

  console.log('Superuser created:', email)
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
