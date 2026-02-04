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

**Environment Variables (REQUIRED):**

```
PORT=4000
JWT_SECRET=your_secure_random_32_char_string
CORS_ORIGIN=*
ADMIN_EMAIL=admin@dentalprep.com
ADMIN_PASSWORD=your_secure_password
NODE_ENV=production
```

### Generate JWT Secret:

Run this command locally to generate a secure JWT secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the output and use it as your `JWT_SECRET`.

### Important Notes:

1. **NO MongoDB Required!** 
   - The app uses JSON file storage
   - Data stored in `backend/data/` directory
   - No external database setup needed

2. **Admin User Auto-Created**
   - On first startup, an admin user is automatically created
   - Email: Value from `ADMIN_EMAIL` env var
   - Password: Value from `ADMIN_PASSWORD` env var
   - **IMPORTANT:** Change `ADMIN_PASSWORD` from default!

3. **CORS Origin:** 
   - Set to `*` for testing
   - For production, set to your Render URL: `https://your-app-name.onrender.com`

### Deployment Steps:

1. **Push code to GitHub**
   ```bash
   git add .
   git commit -m "Fixed deployment issues"
   git push
   ```

2. **Create Web Service on Render**
   - Go to https://render.com
   - Click "New +" → "Web Service"
   - Connect your GitHub repository

3. **Configure Service**
   - **Language:** Node
   - **Root Directory:** `.` (or leave blank)
   - **Build Command:** `chmod +x build.sh && ./build.sh`
   - **Start Command:** `cd backend && npm start`

4. **Add Environment Variables**
   - Click "Environment" tab
   - Add all variables listed above
   - **Don't forget to set JWT_SECRET and ADMIN_PASSWORD!**

5. **Deploy**
   - Click "Create Web Service"
   - Wait for deployment to complete

### Post-Deployment Testing:

1. **Health Check:**
   ```
   https://your-app-name.onrender.com/api/health
   ```
   Should return JSON with `status: "ok"`

2. **Admin Login:**
   - Go to: `https://your-app-name.onrender.com/admin/`
   - Email: Your `ADMIN_EMAIL` value
   - Password: Your `ADMIN_PASSWORD` value

3. **Student Signup:**
   - Go to: `https://your-app-name.onrender.com/signup/`
   - Create a new account
   - Login and test

### Troubleshooting:

**If deployment fails:**
1. Check Render logs for error messages
2. Verify all environment variables are set
3. Ensure `JWT_SECRET` is at least 32 characters
4. Check that build command completed successfully

**If login doesn't work:**
1. Check browser console for errors
2. Verify `ADMIN_EMAIL` and `ADMIN_PASSWORD` match what you're entering
3. Check Render logs for backend errors

**Data Persistence:**
- Render's free tier may reset files on restart
- For production, upgrade to paid plan with persistent disk
- Or migrate to a proper database (MongoDB, PostgreSQL, etc.)

### Performance Notes:

- First request may be slow (cold start on free tier)
- Render free tier sleeps after 15 minutes of inactivity
- Consider upgrading for production use
