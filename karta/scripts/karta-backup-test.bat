@echo off
REM Minimal backup test - isolate exit code issue

set MYSQL_BIN=C:\xampp\mysql\bin
set DB_NAME=karta_erp_v2
set BACKUP_DIR=C:\karta-v2-backups

if not exist "%BACKUP_DIR%" mkdir "%BACKUP_DIR%"

REM Step 1: Test timestamp
for /f %%I in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HH-mm"') do set TIMESTAMP=%%I
echo TIMESTAMP=%TIMESTAMP%

REM Step 2: Test mysqldump
set BACKUP_FILE=%BACKUP_DIR%\karta-v2-test-%TIMESTAMP%.sql
"%MYSQL_BIN%\mysqldump.exe" --user=root --host=127.0.0.1 --port=3306 --single-transaction --routines --triggers --set-charset --default-character-set=utf8mb4 %DB_NAME% > "%BACKUP_FILE%"

REM Step 3: Check file
if not exist "%BACKUP_FILE%" (
    echo FAILED: file not created
    exit /B 1
)

for %%A in ("%BACKUP_FILE%") do set FILESIZE=%%~zA
echo FILE=%BACKUP_FILE%
echo SIZE=%FILESIZE% bytes

if %FILESIZE% EQU 0 (
    echo FAILED: file empty
    del "%BACKUP_FILE%"
    exit /B 1
)

echo SUCCESS
exit /B 0
