# Pozivnice App

Web aplikacija za slanje personaliziranih pozivnica putem emaila s RSVP potvrdom.

## Stack

- **Frontend**: Vue 3 + Vite → [Netlify](https://netlify.com)
- **Backend**: Node.js + Express + Prisma → [Render.com](https://render.com)
- **Baza**: PostgreSQL → [Supabase](https://supabase.com)
- **Email**: [Resend.com](https://resend.com)

## Lokalni razvoj

### Backend

```bash
cd backend
npm install
cp .env.example .env
# Popunite .env s vašim vrijednostima
npx prisma db push
npm run dev
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

## Deployment

### 1. Supabase (baza)

1. Kreirajte projekt na [supabase.com](https://supabase.com)
2. Kopirajte `DATABASE_URL` iz Settings → Database → Connection string (URI format)

### 2. Resend (email)

1. Kreirajte račun na [resend.com](https://resend.com)
2. Generirajte API ključ
3. Opcionalno: dodajte vlastitu domenu

### 3. Render.com (backend)

1. Povežite GitHub repo
2. New Web Service → odaberite `/backend` folder
3. Postavite environment varijable:
   - `DATABASE_URL` - Supabase connection string
   - `RESEND_API_KEY` - vaš Resend API ključ
   - `ADMIN_SECRET` - lozinka za admin panel (izmislite sami)
   - `FRONTEND_URL` - URL vašeg Netlify deploya

### 4. Netlify (frontend)

1. Povežite GitHub repo
2. Base directory: `frontend`
3. Build command: `npm run build`
4. Publish directory: `frontend/dist`
5. Environment variable: `VITE_API_URL` = URL vašeg Render backenda + `/api`

## CSV format

```csv
name,email
Marko Marković,marko@example.com
Ana Anić,ana@example.com
```

## Admin panel

Dostupan na `/admin`. Lozinka je vaš `ADMIN_SECRET`.

## Pozivnica link

`https://your-app.netlify.app/invite?token=<token>`
