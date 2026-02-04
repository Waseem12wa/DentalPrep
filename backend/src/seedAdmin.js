const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, "../data");
const usersFile = path.join(dataDir, "users.json");

async function seedAdmin() {
    try {
        // Ensure data directory exists
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        // Read existing users
        let users = [];
        if (fs.existsSync(usersFile)) {
            const data = fs.readFileSync(usersFile, "utf8");
            users = JSON.parse(data);
        }

        // Check if admin already exists
        const adminEmail = process.env.ADMIN_EMAIL || "admin@dentalprep.com";
        const adminExists = users.some(u => u.email === adminEmail);

        if (!adminExists) {
            const adminPassword = process.env.ADMIN_PASSWORD || "1234";
            const hashedPassword = await bcrypt.hash(adminPassword, 10);

            const adminUser = {
                _id: Date.now().toString(36) + Math.random().toString(36).substr(2),
                name: "Admin",
                email: adminEmail,
                password: hashedPassword,
                role: "admin",
                createdAt: new Date().toISOString()
            };

            users.push(adminUser);
            fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
            console.log(`✅ Admin user created: ${adminEmail}`);
        } else {
            console.log(`ℹ️  Admin user already exists: ${adminEmail}`);
        }
    } catch (err) {
        console.error("❌ Failed to seed admin user:", err);
    }
}

// Run seed if called directly
if (require.main === module) {
    seedAdmin().then(() => {
        console.log("Seed complete");
        process.exit(0);
    });
}

module.exports = seedAdmin;
