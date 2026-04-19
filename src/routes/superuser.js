import { Router } from 'express'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { requireSuperuser } from '../middleware/adminAuth.js'

const router = Router()
const prisma = new PrismaClient()

// ── Admins ──────────────────────────────────────────────────────────────────

router.get('/admins', requireSuperuser, async (req, res) => {
  try {
    const admins = await prisma.admin.findMany({
      select: { id: true, name: true, email: true, isSuperuser: true, createdAt: true },
      orderBy: { createdAt: 'asc' }
    })
    res.json(admins)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch admins' })
  }
})

router.post('/admins', requireSuperuser, async (req, res) => {
  try {
    const { name, email, password } = req.body

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email and password are required' })
    }

    const passwordHash = await bcrypt.hash(password, 12)
    const admin = await prisma.admin.create({
      data: { name, email, passwordHash, isSuperuser: false },
      select: { id: true, name: true, email: true, isSuperuser: true, createdAt: true }
    })

    res.status(201).json(admin)
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'Email already exists' })
    }
    console.error(err)
    res.status(500).json({ error: 'Failed to create admin' })
  }
})

router.delete('/admins/:id', requireSuperuser, async (req, res) => {
  try {
    const { id } = req.params

    const membershipCount = await prisma.projectAdmin.count({ where: { adminId: id } })
    if (membershipCount > 0) {
      return res.status(409).json({ error: `Admin je član ${membershipCount} projekt(a). Uklonite ga s projekata prije brisanja.` })
    }

    await prisma.admin.delete({ where: { id } })
    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to delete admin' })
  }
})

// ── Projects ─────────────────────────────────────────────────────────────────

router.get('/projects', requireSuperuser, async (req, res) => {
  try {
    const projects = await prisma.project.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { members: true, groups: true } }
      }
    })
    res.json(projects)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch projects' })
  }
})

router.post('/projects', requireSuperuser, async (req, res) => {
  try {
    const { name, description } = req.body
    if (!name) {
      return res.status(400).json({ error: 'Name is required' })
    }

    const project = await prisma.project.create({
      data: { name, description },
      include: { _count: { select: { members: true, groups: true } } }
    })
    res.status(201).json(project)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to create project' })
  }
})

router.delete('/projects/:id', requireSuperuser, async (req, res) => {
  try {
    await prisma.project.delete({ where: { id: req.params.id } })
    res.json({ success: true })
  } catch (err) {
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'Project not found' })
    }
    console.error(err)
    res.status(500).json({ error: 'Failed to delete project' })
  }
})

router.get('/projects/:id/members', requireSuperuser, async (req, res) => {
  try {
    const members = await prisma.projectAdmin.findMany({
      where: { projectId: req.params.id },
      include: { admin: { select: { id: true, name: true, email: true } } },
      orderBy: { assignedAt: 'asc' }
    })
    res.json(members.map(m => ({ ...m.admin, assignedAt: m.assignedAt })))
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch members' })
  }
})

router.post('/projects/:id/members', requireSuperuser, async (req, res) => {
  try {
    const { adminId } = req.body
    if (!adminId) {
      return res.status(400).json({ error: 'adminId is required' })
    }

    await prisma.projectAdmin.create({
      data: { projectId: req.params.id, adminId }
    })
    res.status(201).json({ success: true })
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'Admin is already a member' })
    }
    if (err.code === 'P2003') {
      return res.status(404).json({ error: 'Project or admin not found' })
    }
    console.error(err)
    res.status(500).json({ error: 'Failed to add member' })
  }
})

router.delete('/projects/:id/members/:adminId', requireSuperuser, async (req, res) => {
  try {
    await prisma.projectAdmin.delete({
      where: { projectId_adminId: { projectId: req.params.id, adminId: req.params.adminId } }
    })
    res.json({ success: true })
  } catch (err) {
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'Membership not found' })
    }
    console.error(err)
    res.status(500).json({ error: 'Failed to remove member' })
  }
})

export default router
