//clean-db.js
// Removes database.db if it exists.

const fs = require('fs');
const path = require('path');

const dbFile = path.join(__dirname, '..', 'database.db');

try {
    if (fs.existsSync(dbFile)) {
        fs.unlinkSync(dbFile);
        console.log('database.db deleted');
    } else {
        console.log('database.db not found');
    }
} catch (err) {
    console.error(err);
    process.exit(1);
}
