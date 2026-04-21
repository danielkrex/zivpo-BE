import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import adminRoutes from './routes/admin.js'
import invitationRoutes from './routes/invitation.js'
import authRoutes from './routes/auth.js'
import superuserRoutes from './routes/superuser.js'

const app = express()
const PORT = process.env.PORT || 3000

app.use(cors({
  origin: [process.env.FRONTEND_URL, 'http://localhost:5173'],
  credentials: true
}))

app.use(express.json())

app.get('/health', (req, res) => res.json({ status: 'ok' }))
app.get('/healthz', (req, res) => res.send('OK'))

app.use('/api/auth', authRoutes)
app.use('/api/admin', adminRoutes)
app.use('/api/invitation', invitationRoutes)
app.use('/api/superuser', superuserRoutes)

app.use((err, req, res, next) => {
  console.error(err)
  res.status(500).json({ error: 'Internal server error' })
})

app.listen(PORT, () => console.log(`Server running on port ${PORT}`))
