// Routes for the default home page.

const express = require('express');
const router = express.Router();

// Purpose: Render the main home page with links to Organiser and Attendee areas.
// Inputs: req (session may be empty), res
// Outputs: HTML response (renders the main view)
router.get('/', function (req, res) {
    res.render('main');
});

module.exports = router;
