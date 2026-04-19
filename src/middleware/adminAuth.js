import jwt from 'jsonwebtoken'

export function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization']
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    req.admin = jwt.verify(token, process.env.JWT_SECRET)
    next()
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }
}

export function requireSuperuser(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.admin.isSuperuser) {
      return res.status(403).json({ error: 'Forbidden' })
    }
    next()
  })
}

export function requireProjectMember(prisma) {
  return async (req, res, next) => {
    const { projectId } = req.params
    if (!projectId) {
      return res.status(400).json({ error: 'Missing projectId' })
    }

    try {
      const membership = await prisma.projectAdmin.findUnique({
        where: { projectId_adminId: { projectId, adminId: req.admin.adminId } },
        include: { project: true }
      })

      if (!membership) {
        return res.status(403).json({ error: 'Forbidden' })
      }

      req.project = membership.project
      next()
    } catch (err) {
      console.error(err)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
}
