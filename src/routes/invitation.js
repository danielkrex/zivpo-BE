import { Router } from 'express'
import { PrismaClient } from '@prisma/client'

const router = Router()
const prisma = new PrismaClient()

const guestSelect = {
  id: true,
  name: true,
  isPrimary: true,
  isChild: true,
  addedByGuest: true,
  status: true,
  respondedAt: true
}

const projectSelect = {
  emailHeading: true, emailEventName: true, emailEventDate: true,
  emailEventLocation: true, emailBodyText: true, emailAccentColor: true,
  emailHeaderImageUrl: true, pageHeading: true, pageEventName: true,
  pageEventDate: true, pageEventLocation: true, pageWelcomeText: true,
  pageAccentColor: true, pageHeaderImageUrl: true, designTemplate: true
}

const groupSelect = {
  id: true,
  createdAt: true,
  project: { select: projectSelect },
  guests: {
    orderBy: [{ isPrimary: 'desc' }, { isChild: 'asc' }, { createdAt: 'asc' }],
    select: guestSelect
  }
}

// GET invitation group by token
router.get('/:token', async (req, res) => {
  try {
    const group = await prisma.invitationGroup.findUnique({
      where: { token: req.params.token },
      select: groupSelect
    })

    if (!group) return res.status(404).json({ error: 'Pozivnica nije pronađena' })

    res.json(group)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

// PUT update RSVP za pojedinog gosta
router.put('/:token/rsvp', async (req, res) => {
  try {
    const { guestId, status } = req.body
    const validStatuses = ['ATTENDING', 'NOT_ATTENDING', 'MAYBE']

    if (!guestId) return res.status(400).json({ error: 'guestId je obavezan' })
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Nevažeći status' })

    const group = await prisma.invitationGroup.findUnique({
      where: { token: req.params.token },
      include: { guests: true }
    })

    if (!group) return res.status(404).json({ error: 'Pozivnica nije pronađena' })
    if (!group.guests.some(g => g.id === guestId)) {
      return res.status(403).json({ error: 'Gost ne pripada ovoj pozivnici' })
    }

    await prisma.guest.update({
      where: { id: guestId },
      data: { status, respondedAt: new Date() }
    })

    const updated = await prisma.invitationGroup.findUnique({
      where: { token: req.params.token },
      select: groupSelect
    })

    res.json(updated)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to update RSVP' })
  }
})

// POST dodaj gosta (pratnju ili dijete) iz pozivnice
// Pravilo: 1 gost → može dodati pratnju ili dijete
//          2+ gostiju → može dodati samo dijete
router.post('/:token/guest', async (req, res) => {
  try {
    const { name, isChild } = req.body

    if (!name?.trim()) return res.status(400).json({ error: 'Ime je obavezno' })

    const group = await prisma.invitationGroup.findUnique({
      where: { token: req.params.token },
      include: { guests: true }
    })

    if (!group) return res.status(404).json({ error: 'Pozivnica nije pronađena' })

    const currentCount = group.guests.length

    // Ako su već 2+ gostiju, može se dodati samo dijete
    if (currentCount >= 2 && !isChild) {
      return res.status(400).json({ error: 'Možete dodati samo dijete kada je pratnja već dodana' })
    }

    await prisma.guest.create({
      data: {
        name: name.trim(),
        isChild: !!isChild,
        addedByGuest: true,
        groupId: group.id
      }
    })

    const updated = await prisma.invitationGroup.findUnique({
      where: { token: req.params.token },
      select: groupSelect
    })

    res.json(updated)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to add guest' })
  }
})

export default router
