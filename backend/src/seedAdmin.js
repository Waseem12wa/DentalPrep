const bcrypt = require("bcryptjs");
const { User, generateId } = require("./db");

async function seedAdmin() {
    try {
        const adminEmail = process.env.ADMIN_EMAIL || "admin@dentalprep.com";
        const adminPassword = process.env.ADMIN_PASSWORD || "1234";
        const hashedPassword = await bcrypt.hash(adminPassword, 10);
        const adminExists = await User.findOne({ email: adminEmail });

        if (!adminExists) {
            await User.create({
                _id: `user_${generateId()}`,
                name: "Admin",
                email: adminEmail,
                password: hashedPassword,
                passwordHash: hashedPassword,
                isVerified: true,
                accountStatus: "active", // Explicitly setting account status to active
                role: "admin",
                createdAt: new Date(),
                updatedAt: new Date()
            });

            console.log(`✅ Admin user created: ${adminEmail}`);
        } else {
            adminExists.password = hashedPassword;
            adminExists.passwordHash = hashedPassword;
            adminExists.role = "admin";
            adminExists.accountStatus = "active";
            await adminExists.save();
            console.log(`✅ Admin user password updated: ${adminEmail}`);
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
