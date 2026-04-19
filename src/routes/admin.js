import { Router } from 'express'
import multer from 'multer'
import { parse } from 'csv-parse/sync'
import { PrismaClient } from '@prisma/client'
import { Resend } from 'resend'
import { requireAuth, requireProjectMember } from '../middleware/adminAuth.js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const elegantEmailTemplate = readFileSync(join(__dirname, '../elegant-email-2.html'), 'utf-8')

const router = Router()
const prisma = new PrismaClient()
const resend = new Resend(process.env.RESEND_API_KEY)
const upload = multer({ storage: multer.memoryStorage() })

// GET projects for the current admin
router.get('/projects', requireAuth, async (req, res) => {
  try {
    const memberships = await prisma.projectAdmin.findMany({
      where: { adminId: req.admin.adminId },
      include: {
        project: {
          include: { _count: { select: { groups: true } } }
        }
      },
      orderBy: { assignedAt: 'desc' }
    })
    res.json(memberships.map(m => m.project))
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch projects' })
  }
})

// GET all invitation groups for a project
router.get('/projects/:projectId/invitations', requireAuth, requireProjectMember(prisma), async (req, res) => {
  try {
    const groups = await prisma.invitationGroup.findMany({
      where: { projectId: req.project.id },
      orderBy: { createdAt: 'desc' },
      include: { guests: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] } }
    })
    res.json(groups)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch invitations' })
  }
})

// POST upload CSV — grupira po emailu, prvi red = primary contact
router.post('/projects/:projectId/upload-csv', requireAuth, requireProjectMember(prisma), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })

    const csvContent = req.file.buffer.toString('utf-8')
    const records = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    })

    // Grupiramo redove po emailu — redoslijed u CSV-u je bitan
    const groupMap = new Map() // email -> [{ name, isPrimary }]

    for (const record of records) {
      const name = record.name || record.Name || record.ime || record.Ime
      const email = (record.email || record.Email || '').toLowerCase()

      if (!name || !email) continue

      if (!groupMap.has(email)) {
        groupMap.set(email, [])
      }
      groupMap.get(email).push(name)
    }

    const results = { groupsCreated: 0, guestsCreated: 0, skipped: 0, errors: [] }

    for (const [email, names] of groupMap) {
      try {
        await prisma.invitationGroup.create({
          data: {
            email,
            projectId: req.project.id,
            createdByAdminId: req.admin.adminId,
            guests: {
              create: names.map((name, i) => ({
                name,
                isPrimary: i === 0  // prvi u CSV-u = primary contact
              }))
            }
          }
        })
        results.groupsCreated++
        results.guestsCreated += names.length
      } catch (err) {
        if (err.code === 'P2002') {
          results.skipped++
        } else {
          results.errors.push(`Error for ${email}: ${err.message}`)
        }
      }
    }

    res.json(results)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to process CSV' })
  }
})

// POST send invitation emails
router.post('/projects/:projectId/send-invitations', requireAuth, requireProjectMember(prisma), async (req, res) => {
  try {
    const { ids } = req.body // optional: send only specific group IDs

    const where = ids?.length
      ? { id: { in: ids }, emailSent: false, projectId: req.project.id }
      : { emailSent: false, projectId: req.project.id }

    const groups = await prisma.invitationGroup.findMany({
      where,
      include: { guests: { orderBy: { isPrimary: 'desc' } } }
    })

    if (groups.length === 0) {
      return res.json({ sent: 0, message: 'No pending invitations to send' })
    }

    let sent = 0
    const errors = []

    for (const group of groups) {
      const primaryGuest = group.guests.find(g => g.isPrimary) || group.guests[0]
      const invitationUrl = `${process.env.FRONTEND_URL}/invite?token=${group.token}`

      try {
        const emailHtml = req.project.designTemplate === 'elegant'
          ? buildElegantEmailHtml(primaryGuest.name, group.guests, invitationUrl, req.project)
          : buildEmailHtml(primaryGuest.name, group.guests, invitationUrl, req.project)

        await resend.emails.send({
          from: 'Pozivnica <onboarding@resend.dev>',
          to: group.email,
          subject: req.project.emailSubject || 'Pozivnica za poseban događaj',
          html: emailHtml
        })

        await prisma.invitationGroup.update({
          where: { id: group.id },
          data: { emailSent: true, sentAt: new Date() }
        })

        sent++
      } catch (err) {
        errors.push(`Failed for ${group.email}: ${err.message}`)
      }
    }

    res.json({ sent, errors })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to send invitations' })
  }
})

// POST resend email for a single invitation group
router.post('/projects/:projectId/invitations/:id/send', requireAuth, requireProjectMember(prisma), async (req, res) => {
  try {
    const group = await prisma.invitationGroup.findUnique({
      where: { id: req.params.id },
      include: { guests: { orderBy: { isPrimary: 'desc' } } }
    })

    if (!group) return res.status(404).json({ error: 'Pozivnica nije pronađena' })
    if (group.projectId !== req.project.id) return res.status(403).json({ error: 'Forbidden' })

    const primaryGuest = group.guests.find(g => g.isPrimary) || group.guests[0]
    const invitationUrl = `${process.env.FRONTEND_URL}/invite?token=${group.token}`

    const emailHtml = req.project.designTemplate === 'elegant'
      ? buildElegantEmailHtml(primaryGuest.name, group.guests, invitationUrl, req.project)
      : buildEmailHtml(primaryGuest.name, group.guests, invitationUrl, req.project)

    await resend.emails.send({
      from: 'Pozivnica <onboarding@resend.dev>',
      to: group.email,
      subject: req.project.emailSubject || 'Pozivnica za poseban događaj',
      html: emailHtml
    })

    await prisma.invitationGroup.update({
      where: { id: group.id },
      data: { emailSent: true, sentAt: new Date() }
    })

    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Greška pri slanju emaila: ' + err.message })
  }
})

// GET project settings (theme fields)
router.get('/projects/:projectId/settings', requireAuth, requireProjectMember(prisma), async (req, res) => {
  res.json(req.project)
})

// PUT update project settings (email template + landing page theme)
router.put('/projects/:projectId/settings', requireAuth, requireProjectMember(prisma), async (req, res) => {
  try {
    const allowed = [
      'emailSubject', 'emailHeading', 'emailEventName', 'emailEventDate',
      'emailEventLocation', 'emailBodyText', 'emailAccentColor', 'emailHeaderImageUrl',
      'pageHeading', 'pageEventName', 'pageEventDate', 'pageEventLocation',
      'pageWelcomeText', 'pageAccentColor', 'pageHeaderImageUrl', 'designTemplate'
    ]
    const data = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    )
    const updated = await prisma.project.update({
      where: { id: req.project.id },
      data
    })
    res.json(updated)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to update settings' })
  }
})

// POST create a single invitation group manually
router.post('/projects/:projectId/invitations', requireAuth, requireProjectMember(prisma), async (req, res) => {
  try {
    const { email, guests } = req.body

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Nevažeća email adresa' })
    }
    if (!Array.isArray(guests) || guests.length === 0) {
      return res.status(400).json({ error: 'Potreban je najmanje jedan gost' })
    }
    const validGuests = guests.filter(g => g.name?.trim())
    if (validGuests.length === 0) {
      return res.status(400).json({ error: 'Ime gosta ne smije biti prazno' })
    }

    const group = await prisma.invitationGroup.create({
      data: {
        email: email.toLowerCase().trim(),
        projectId: req.project.id,
        createdByAdminId: req.admin.adminId,
        guests: {
          create: validGuests.map((g, i) => ({
            name: g.name.trim(),
            isPrimary: i === 0,
            isChild: g.isChild === true
          }))
        }
      },
      include: { guests: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] } }
    })

    res.status(201).json(group)
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'Pozivnica s ovom email adresom već postoji' })
    }
    console.error(err)
    res.status(500).json({ error: 'Greška pri kreiranju pozivnice' })
  }
})

// DELETE invitation group (kaskadno briše i gostove)
router.delete('/projects/:projectId/invitations/:id', requireAuth, requireProjectMember(prisma), async (req, res) => {
  try {
    const group = await prisma.invitationGroup.findUnique({ where: { id: req.params.id } })

    if (!group) {
      return res.status(404).json({ error: 'Invitation not found' })
    }

    if (group.projectId !== req.project.id) {
      return res.status(403).json({ error: 'Forbidden' })
    }

    await prisma.invitationGroup.delete({ where: { id: req.params.id } })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete invitation' })
  }
})

function buildEmailHtml(primaryName, guests, url, project = {}) {
  const hasCompanions = guests.length > 1
  const companionNames = guests.filter(g => !g.isPrimary).map(g => g.name)

  const heading = project.emailHeading || '✉ Pozivnica'
  const eventName = project.emailEventName || null
  const eventDate = project.emailEventDate || null
  const eventLocation = project.emailEventLocation || null
  const bodyText = project.emailBodyText || 'Imate čast biti pozvani na naš poseban događaj. Vaša prisutnost bila bi nam velika čast i radost.'
  const accentColor = project.emailAccentColor || '#2d1b4e'
  const headerImageUrl = project.emailHeaderImageUrl || null

  const companionText = hasCompanions
    ? `<p class="message">Poziv se odnosi i na Vašu pratnju: <strong>${companionNames.join(', ')}</strong>.</p>`
    : ''

  const eventDetailsText = (eventDate || eventLocation || eventName)
    ? `<p class="message">${[eventName, eventDate, eventLocation].filter(Boolean).join(' · ')}</p>`
    : ''

  const headerHtml = headerImageUrl
    ? `<div class="header"><img src="${headerImageUrl}" alt="${heading}" style="width:100%;max-height:200px;object-fit:cover;display:block;" /><h1 style="color:#f5d77a;margin:12px 0 0;font-size:28px;letter-spacing:2px;">${heading}</h1></div>`
    : `<div class="header"><h1>${heading}</h1></div>`

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: Georgia, serif; background: #f9f6f0; margin: 0; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.08); }
    .header { background: linear-gradient(135deg, ${accentColor}, ${accentColor}cc); padding: 40px; text-align: center; }
    .header h1 { color: #f5d77a; margin: 0; font-size: 28px; letter-spacing: 2px; }
    .body { padding: 40px; }
    .greeting { font-size: 20px; color: ${accentColor}; margin-bottom: 16px; }
    .message { color: #555; line-height: 1.7; font-size: 16px; margin-bottom: 12px; }
    .btn { display: inline-block; margin: 30px 0; padding: 16px 40px; background: linear-gradient(135deg, ${accentColor}, ${accentColor}cc); color: white !important; text-decoration: none; border-radius: 50px; font-size: 16px; font-weight: bold; letter-spacing: 1px; }
    .footer { padding: 20px 40px; background: #f9f6f0; text-align: center; color: #999; font-size: 13px; }
    .url-note { word-break: break-all; color: #888; font-size: 12px; margin-top: 20px; }
  </style>
</head>
<body>
  <div class="container">
    ${headerHtml}
    <div class="body">
      <p class="greeting">Dragi/a ${primaryName},</p>
      <p class="message">${bodyText}</p>
      ${eventDetailsText}
      ${companionText}
      <p class="message">Molimo Vas da potvrdite dolazak klikom na dugme ispod.</p>
      <div style="text-align: center;">
        <a href="${url}" class="btn">Otvori pozivnicu</a>
      </div>
      <p class="url-note">Ili kopirajte link: <a href="${url}">${url}</a></p>
    </div>
    <div class="footer">
      Ova pozivnica je osobna i namijenjena samo Vama${hasCompanions ? ' i Vašoj pratnji' : ''}.
    </div>
  </div>
</body>
</html>`
}

function buildElegantEmailHtml(primaryName, guests, url, project = {}) {
  const hasCompanions = guests.length > 1
  const companionNames = guests.filter(g => !g.isPrimary).map(g => g.name)

  const companionBlock = hasCompanions
    ? `<table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%" style="margin-right: auto; margin-left: auto;">
        <tr>
          <td valign="top" align="center">
            <div class="pc-font-alt" style="text-decoration: none;">
              <div style="text-align:center;text-align-last:center;font-family:'Georgia', Times New Roman, Times, serif;font-size:14px;line-height:140%;"><span style="font-family: 'Georgia', Times New Roman, Times, serif; color: rgb(81, 81, 81); font-style: normal; font-weight: 400; font-size: 14px; line-height: 140%; letter-spacing: 0.5px;">Poziv se odnosi i na Vašu pratnju:</span><span style="font-family: 'Georgia', Times New Roman, Times, serif; color: rgb(81, 81, 81); font-style: normal; font-weight: 700; font-size: 14px; line-height: 140%; letter-spacing: 0.5px;"> ${companionNames.join(', ')}</span>
              </div>
              <div style="text-align:center;text-align-last:center;line-height:140%;font-size:14px;font-family:'Georgia', Times New Roman, Times, serif;"><br></div>
            </div>
          </td>
        </tr>
      </table>`
    : ''

  return elegantEmailTemplate
    .replace('{{HEADING}}', project.emailHeading || 'S+D')
    .replace('{{EVENT_NAME}}', project.emailEventName || '')
    .replace('{{EVENT_DATE}}', project.emailEventDate || '')
    .replace('{{EVENT_LOCATION}}', project.emailEventLocation || '')
    .replace('{{PRIMARY_NAME}}', primaryName)
    .replace('{{BODY_TEXT}}', project.emailBodyText || 'Imate čast biti pozvani na naš poseban događaj. Vaša prisutnost bila bi nam velika čast i radost.')
    .replace('{{COMPANION_BLOCK}}', companionBlock)
    .replaceAll('{{INVITATION_URL}}', url)
    .replace('{{FOOTER_TEXT}}', hasCompanions ? 'Ova pozivnica je osobna i namijenjena samo Vama i Vašoj pratnji.' : 'Ova pozivnica je osobna i namijenjena samo Vama.')
}

export default router
