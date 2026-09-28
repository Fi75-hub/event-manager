// scripts/build-db.js
// Rebuilds database.db by executing the SQL in dbschema.sql.

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbFile = path.join(__dirname, '..', 'database.db');
const schemaFile = path.join(__dirname, '..', 'db_schema.sql');

// Log an error and exit the build script with a non-zero code.
function exitWithError(err) {
    console.error(err);
    process.exit(1);
}

let schemaSql = '';
try {
    schemaSql = fs.readFileSync(schemaFile, 'utf8');
} catch (err) {
    exitWithError('Could not read db_schema.sql');
}

try {
    if (fs.existsSync(dbFile)) {
        fs.unlinkSync(dbFile);
    }
} catch (err) {
    exitWithError('Could not remove existing database.db');
}

const db = new sqlite3.Database(dbFile, function (err) {
    if (err) {
        exitWithError(err);
        return;
    }

    db.exec(schemaSql, function (execErr) {
        if (execErr) {
            db.close(function () {
                exitWithError(execErr);
            });
            return;
        }

        db.close(function (closeErr) {
            if (closeErr) {
                exitWithError(closeErr);
                return;
            }

            console.log('Database rebuilt successfully');
        });
    });
});
