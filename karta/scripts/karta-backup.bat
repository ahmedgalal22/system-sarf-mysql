@echo off
set MYSQL_BIN=C:\xampp\mysql\bin
set DB_HOST=127.0.0.1
set DB_PORT=3306
set DB_USER=root
set DB_NAME=karta_erp
set BACKUP_DIR=C:\karta-backups
set MAX_BACKUPS=5
set LOGFILE=%BACKUP_DIR%\backup.log

if not exist "%BACKUP_DIR%" mkdir "%BACKUP_DIR%"

for /f %%I in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HH-mm"') do set TIMESTAMP=%%I
set BACKUP_FILE=%BACKUP_DIR%\karta-auto-%TIMESTAMP%.sql

"%MYSQL_BIN%\mysql.exe" --user=%DB_USER% --host=%DB_HOST% --port=%DB_PORT% -e "SELECT 1" %DB_NAME% >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [%TIMESTAMP%] FAILED: MySQL not running >> "%LOGFILE%"
    exit /B 1
)

"%MYSQL_BIN%\mysqldump.exe" --user=%DB_USER% --host=%DB_HOST% --port=%DB_PORT% --single-transaction --routines --triggers --set-charset --default-character-set=utf8mb4 %DB_NAME% > "%BACKUP_FILE%" 2>>"%LOGFILE%"

if not exist "%BACKUP_FILE%" (
    echo [%TIMESTAMP%] FAILED: Backup file not created >> "%LOGFILE%"
    exit /B 1
)

set FILESIZE=0
for %%A in ("%BACKUP_FILE%") do set FILESIZE=%%~zA
if %FILESIZE% EQU 0 (
    echo [%TIMESTAMP%] FAILED: Backup file empty >> "%LOGFILE%"
    del "%BACKUP_FILE%"
    exit /B 1
)

echo [%TIMESTAMP%] SUCCESS: %FILESIZE% bytes >> "%LOGFILE%"

"%MYSQL_BIN%\mysql.exe" --user=%DB_USER% --host=%DB_HOST% --port=%DB_PORT% %DB_NAME% -e "INSERT INTO backup_metadata (id, last_backup_at, last_backup_by, backup_count, last_backup_size) VALUES (1, NOW(), 'auto', 1, %FILESIZE%) ON DUPLICATE KEY UPDATE last_backup_at = NOW(), last_backup_by = 'auto', backup_count = backup_count + 1, last_backup_size = VALUES(last_backup_size);" >nul 2>&1

set COUNT=0
for %%F in ("%BACKUP_DIR%\karta-auto-*.sql") do set /A COUNT+=1
if %COUNT% GTR %MAX_BACKUPS% (
    for /f "skip=%MAX_BACKUPS% delims=" %%F in ('dir /B /O-D "%BACKUP_DIR%\karta-auto-*.sql"') do del "%BACKUP_DIR%\%%F"
)

exit /B 0
