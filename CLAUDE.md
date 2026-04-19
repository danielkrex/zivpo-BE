# Pozivnice — Architecture & Dev Guide

Wedding/event invitation system. Admin imports guests via CSV, sends personalised email invitations, guests RSVP via a unique link.

---

## Stack

| Layer | Tech | Host |
|---|---|---|
| Frontend | Vue 3 + Vite + Pinia + Vue Router | Netlify |
| Backend | Node.js + Express (ESM) | Render.com |
| Database | PostgreSQL via Prisma ORM | Supabase |
| Email | Resend.com | — |
| File storage | Supabase Storage (bucket: `project-assets`, public) | Supabase |

---

## Directory structure

```
pozivnice/
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma       # DB models: Admin, Project, ProjectAdmin, InvitationGroup, Guest
│   │   └── seed.js             # Creates superuser from env vars
│   └── src/
│       ├── index.js            # Express entry — mounts all routes
│       ├── middleware/
│       │   └── adminAuth.js    # requireAuth + requireSuperuser + requireProjectMember
│       └── routes/
│           ├── auth.js         # POST /api/auth/login
│           ├── admin.js        # /api/admin/* — project-scoped, requireProjectMember
│           ├── superuser.js    # /api/superuser/* — superuser only
│           └── invitation.js   # /api/invitation/* — public (guest-facing)
└── frontend/
    └── src/
        ├── main.js             # createApp + Pinia + Router
        ├── router/index.js     # Routes + beforeEach auth guard
        ├── lib/
        │   └── supabase.js         # Supabase client (VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY)
        ├── composables/
        │   └── useStorageUpload.js # uploadImage(projectId, file) → public URL via Supabase Storage
        ├── stores/
        │   ├── auth.js         # useAuthStore — token, adminInfo, login/logout
        │   └── invitation.js   # useInvitationStore (guest) + useAdminApi (admin)
        ├── views/
        │   ├── LoginView.vue       # /login
        │   ├── AdminView.vue       # /admin  — project list (requiresAuth)
        │   ├── ProjectView.vue     # /admin/projects/:projectId — invitations + Postavke tab
        │   ├── SuperuserView.vue   # /admin/superuser  (requiresSuperuser)
        │   └── InvitationView.vue  # /invite?token=...  (public, uses project theme)
        └── components/
            ├── UploadCsv.vue   # Drag-drop CSV uploader, takes adminApi + projectId props
            └── RsvpButtons.vue # RSVP status buttons for guests
```

---

## Auth system

### How it works
1. Admin logs in at `/login` → `POST /api/auth/login` → bcrypt verify → returns 8h JWT
2. JWT payload: `{ adminId, isSuperuser }`
3. Token stored in `localStorage.authToken`, admin info in `localStorage.adminInfo`
4. All `/api/admin/*` and `/api/superuser/*` requests send `Authorization: Bearer <token>`

### Middleware (`backend/src/middleware/adminAuth.js`)
- `requireAuth` — verifies JWT, attaches `req.admin = { adminId, isSuperuser }`
- `requireSuperuser` — calls requireAuth then checks `req.admin.isSuperuser`
- `requireProjectMember(prisma)` — factory; reads `:projectId` from params, checks `ProjectAdmin` record exists for `(projectId, req.admin.adminId)`, attaches `req.project`; returns 403 if not a member

### Frontend store (`frontend/src/stores/auth.js`)
- `useAuthStore()` — `isAuthenticated`, `isSuperuser`, `login()`, `logout()`, `authHeaders()`
- `authHeaders()` returns `{ Authorization: 'Bearer <token>' }` — used by `useAdminApi()`

### Router guard (`frontend/src/router/index.js`)
- Routes with `meta: { requiresAuth: true }` → redirect to `/login` if not authenticated
- Routes with `meta: { requiresSuperuser: true }` → redirect to `/admin` if not superuser

---

## Database schema

```
Admin
  id, name, email, passwordHash, isSuperuser, createdAt
  └── projects: ProjectAdmin[]

Project
  id, name, description?, createdAt, updatedAt
  ├── members: ProjectAdmin[]
  └── groups: InvitationGroup[]
  Email template fields (all String?):
    emailSubject, emailHeading, emailEventName, emailEventDate,
    emailEventLocation, emailBodyText, emailAccentColor, emailHeaderImageUrl
  Landing page fields (all String?):
    pageHeading, pageEventName, pageEventDate, pageEventLocation,
    pageWelcomeText, pageAccentColor, pageHeaderImageUrl

ProjectAdmin  (junction)
  projectId → Project  (onDelete: Cascade)
  adminId   → Admin    (onDelete: Cascade)
  assignedAt
  @@id([projectId, adminId])

InvitationGroup
  id, email (unique), token (uuid, unique), emailSent, sentAt, createdAt, updatedAt
  createdByAdminId  (audit — who uploaded; NOT a cascade-delete FK)
  projectId → Project  (onDelete: Cascade)
  └── guests: Guest[]

Guest
  id, name, isPrimary, isChild, addedByGuest, status (enum), respondedAt, groupId, createdAt

RsvpStatus enum: PENDING | ATTENDING | NOT_ATTENDING | MAYBE
```

### Key data rules
- One `InvitationGroup` per email address (enforced by `@unique`)
- First guest in a CSV group = `isPrimary: true` (receives the email)
- Guests can add companions themselves at RSVP time (`addedByGuest: true`)
- Deleting a **Project** cascades → InvitationGroups → Guests
- Deleting a **Group** cascades to all its guests
- Groups are scoped to a **project** — all `/api/admin/*` queries filter by `projectId: req.project.id`
- `createdByAdminId` is an audit field only; deleting an admin does NOT delete their groups
- Deleting an admin is blocked if they have active `ProjectAdmin` memberships (must remove from projects first)

---

## API routes

### Public
| Method | Path | Description |
|---|---|---|
| GET | `/api/invitation/:token` | Fetch group+guests by token |
| PUT | `/api/invitation/:token/rsvp` | Update guest RSVP status |
| POST | `/api/invitation/:token/guest` | Guest adds a companion |

### Admin (requireAuth)
| Method | Path | Description |
|---|---|---|
| GET | `/api/admin/projects` | Projects this admin belongs to |
| GET | `/api/admin/projects/:projectId/invitations` | All groups in project |
| GET | `/api/admin/projects/:projectId/settings` | Project theme/settings |
| PUT | `/api/admin/projects/:projectId/settings` | Update project theme/settings |
| POST | `/api/admin/projects/:projectId/upload-csv` | Bulk import from CSV (multipart) |
| POST | `/api/admin/projects/:projectId/send-invitations` | Send emails via Resend |
| DELETE | `/api/admin/projects/:projectId/invitations/:id` | Delete group |
| POST | `/api/auth/login` | Login → JWT |

All `:projectId` routes go through `requireProjectMember(prisma)` after `requireAuth`.

### Superuser (requireSuperuser)
| Method | Path | Description |
|---|---|---|
| GET | `/api/superuser/admins` | List all admins |
| POST | `/api/superuser/admins` | Create admin (non-superuser) |
| DELETE | `/api/superuser/admins/:id` | Delete admin (blocked if on any project) |
| GET | `/api/superuser/projects` | List all projects |
| POST | `/api/superuser/projects` | Create project (`name`, `description`) |
| DELETE | `/api/superuser/projects/:id` | Delete project (cascades) |
| GET | `/api/superuser/projects/:id/members` | List admins on project |
| POST | `/api/superuser/projects/:id/members` | Add admin to project (`{ adminId }`) |
| DELETE | `/api/superuser/projects/:id/members/:adminId` | Remove admin from project |

---

## Environment variables

### Backend (`.env`)
```
DATABASE_URL=          # Supabase pooled connection (pgbouncer=true)
DIRECT_URL=            # Supabase direct connection (used by Prisma migrations)
RESEND_API_KEY=        # Resend.com API key
JWT_SECRET=            # Secret for signing JWTs — keep strong and private
SUPERUSER_EMAIL=       # Email for the superuser account (used by seed)
SUPERUSER_PASSWORD=    # Password for the superuser account (used by seed)
FRONTEND_URL=          # CORS origin (e.g. https://your-app.netlify.app)
PORT=3000
```

### Frontend (`.env` / Netlify)
```
VITE_API_URL=          # Full API base URL in production (e.g. https://your-api.render.com/api)
                       # In dev, Vite proxy handles /api → localhost:3000
VITE_SUPABASE_URL=     # Supabase project URL (same project as DATABASE_URL)
VITE_SUPABASE_ANON_KEY= # Supabase anon/public key — safe for browser
```

---

## Local dev workflow

```bash
# 1. Start backend
cd backend
npm install
cp .env.example .env   # fill in values
npx prisma db push --force-reset   # WARNING: drops all data
npx prisma db seed     # creates superuser from SUPERUSER_EMAIL + SUPERUSER_PASSWORD
npm run dev            # nodemon on port 3000

# 2. Start frontend (separate terminal)
cd frontend
npm install
npm run dev            # Vite on port 5173, proxies /api → :3000
```

Login at `http://localhost:5173/login` with your superuser credentials.

### DB schema changes
- Dev: `npx prisma db push` (or `--force-reset` if adding non-nullable columns)
- Prod: `npx prisma migrate dev` + `npx prisma migrate deploy`

---

## Deployment

### Render.com (backend)
- Root dir: `backend`
- Build: `npm install && npx prisma generate`
- Start: `node src/index.js`
- Env vars: all from `.env` except `PORT` (Render injects it)
- After first deploy: run `npx prisma db seed` once via Render shell

### Netlify (frontend)
- Base dir: `frontend`
- Build: `npm run build`
- Publish: `frontend/dist`
- Env var: `VITE_API_URL` = `https://<your-render-service>.onrender.com/api`

---

## Key design decisions & gotchas

- **ESM throughout backend** — `"type": "module"` in `package.json`. Always use `.js` extensions in imports.
- **Three-layer hierarchy** — Superuser → Project → Admin. Superuser creates projects and assigns admins; admins manage invitations within their assigned projects.
- **Multi-tenant by project** — every `InvitationGroup` belongs to a `Project`. Admins only see/edit groups in projects they're members of (`requireProjectMember` enforces this).
- **Superuser vs Admin** — `isSuperuser: true` gives access to `/api/superuser/*` and `/admin/superuser`. Regular admins only manage invitations within their projects.
- **`createdByAdminId` is audit-only** — it records who uploaded the CSV but is not a cascade-delete FK. Deleting an admin does not delete their groups.
- **Seed is idempotent** — running `npx prisma db seed` twice is safe; it checks for existing email before creating.
- **CSV grouping** — rows with the same email in the CSV are merged into one `InvitationGroup`. The first row = primary contact (receives the email). Order in CSV matters.
- **Token-based RSVP links** — guests access their invitation via `?token=<uuid>`. No login required for guests.
- **Email sender** — currently uses `onboarding@resend.dev` (Resend sandbox). For production, verify a real domain in Resend and update the `from` field in `admin.js`.
- **Vite proxy** — in development `VITE_API_URL` is not set; Vite config proxies all `/api` requests to `localhost:3000`. In production the env var must be set to the full Render URL.
- **Prisma with Supabase** — use `DATABASE_URL` with `?pgbouncer=true` for the app, `DIRECT_URL` without it for migrations.
- **`useAdminApi()` is a plain function** — not a Pinia store. It's called inside components and calls `useAuthStore()` internally to get the Bearer token header. All methods take `projectId` as first argument (except `getProjects()`).
- **Project theme/settings** — `Project` has 15 nullable fields split into email template and landing page groups. All default to `null`; backend and frontend apply fallback defaults at render time, so existing projects without settings look identical to before.
- **Supabase Storage uploads are browser-direct** — images are uploaded from the frontend using `@supabase/supabase-js`, not proxied through Express. The bucket `project-assets` must be set to **public** in the Supabase dashboard. Paths follow `projects/{projectId}/{timestamp}-{filename}`. Backend only stores the resulting public URL string.
- **`GET /api/invitation/:token` includes project theme** — the response now contains a `project` object with all landing page theme fields. `InvitationView` reads `store.group.project` for dynamic styling and content.
