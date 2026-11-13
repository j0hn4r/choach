@echo off
rem Double-click to start Choach and open it in your browser.
cd /d "%~dp0"
start "" http://localhost:4173
node server.js
