# DentalPrep - Render Deployment Guide

## Render Configuration

### Web Service Setup

**Service Type:** Web Service

**Build Command:**
```bash
chmod +x build.sh && ./build.sh
```

**Start Command:**
```bash
cd backend && npm start
```

**Environment Variables:**

```
PORT=4000
JWT_SECRET=<your_secure_random_string>
CORS_ORIGIN=*
ADMIN_EMAIL=admin@dentalprep.com
ADMIN_PASSWORD=<your_secure_admin_password>
```

### Important Notes:

1. **NO MongoDB Required!** 
   - The app now uses JSON file storage
   - Data is stored in `backend/data/` directory
   - No external database setup needed

2. **JWT Secret:** Generate a secure random string (at least 32 characters)
   - You can use: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

3. **Admin Password:** Change from default `1234` to a secure password

4. **CORS Origin:** Set to `*` for development, or your specific domain for production
   - Example: `https://your-app-name.onrender.com`

### Deployment Steps:

1. Push your code to GitHub
2. Create a new Web Service on Render
3. Connect your GitHub repository
4. **Language:** Node
5. **Root Directory:** Leave blank or set to `.`
6. Set the Build Command and Start Command as shown above
7. Add all Environment Variables
8. Deploy!

### Post-Deployment:

- Your app will be available at: `https://your-app-name.onrender.com`
- API endpoints will be at: `https://your-app-name.onrender.com/api/...`
- Admin panel: `https://your-app-name.onrender.com/admin/`

### Health Check:

Test your deployment:
```
https://your-app-name.onrender.com/api/health
```

Should return: `{"status":"ok","time":"..."}`

### Data Persistence:

- Data is stored in JSON files in `backend/data/`
- Render's free tier may reset files on restart
- For production, consider upgrading to a paid plan with persistent disk
