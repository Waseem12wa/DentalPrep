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
MONGO_URI=<your_mongodb_connection_string>
JWT_SECRET=<your_secure_random_string>
CORS_ORIGIN=*
ADMIN_EMAIL=admin@dentalprep.com
ADMIN_PASSWORD=<your_secure_admin_password>
```

### Important Notes:

1. **MongoDB Atlas:** Create a free cluster at https://www.mongodb.com/cloud/atlas
   - Get your connection string and replace `<your_mongodb_connection_string>`
   - Format: `mongodb+srv://username:password@cluster.mongodb.net/dentalprep?retryWrites=true&w=majority`

2. **JWT Secret:** Generate a secure random string (at least 32 characters)
   - You can use: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

3. **Admin Password:** Change from default `1234` to a secure password

4. **CORS Origin:** Set to `*` for development, or your specific domain for production
   - Example: `https://your-app-name.onrender.com`

### Deployment Steps:

1. Push your code to GitHub
2. Create a new Web Service on Render
3. Connect your GitHub repository
4. Set the Build Command and Start Command as shown above
5. Add all Environment Variables
6. Deploy!

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
