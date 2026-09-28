// Routes for the default home page.

const express = require('express');
const router = express.Router();

// Render the main home page with links to Organiser and Attendee areas.
router.get('/', function (req, res) {
    res.render('main');
});

module.exports = router;
