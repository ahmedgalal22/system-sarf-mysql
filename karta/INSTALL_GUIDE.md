# 📋 Karta ERP — دليل التثبيت والتشغيل الكامل
## نظام LAN لـ 5 أجهزة

---

## المتطلبات

### جهاز السيرفر (الجهاز الرئيسي)
- **Windows 10/11**
- **XAMPP** (آخر إصدار) — يشمل Apache + MySQL + PHP 8.x
- تحميل XAMPP: https://www.apachefriends.org

### أجهزة العملاء (4 أجهزة)
- أي متصفح حديث (Chrome / Edge / Firefox)
- اتصال بنفس الشبكة المحلية (LAN)

---

## خطوات التثبيت

### الخطوة 1: تثبيت XAMPP

1. حمّل وثبّت XAMPP على الجهاز الرئيسي
2. أثناء التثبيت اختر: **Apache + MySQL + PHP**
3. مسار التثبيت الافتراضي: `C:\xampp`

### الخطوة 2: نقل ملفات المشروع

1. انسخ مجلد `karta` بالكامل إلى:
```
C:\xampp\htdocs\system52\karta\
```

2. تأكد أن الهيكل يبدو هكذا:
```
C:\xampp\htdocs\system52\karta\
├── app.js
├── index.html
├── login.html
├── index.php
├── setup.php
├── database.sql
├── database_*.sql (12 ملف)
├── api/
├── config/
├── core/
├── repositories/
├── services/
├── tests_v2/
└── ...
```

### الخطوة 3: تشغيل XAMPP

1. افتح **XAMPP Control Panel**
2. اضغط **Start** بجانب **Apache**
3. اضغط **Start** بجانب **MySQL**
4. تأكد أن كلاهما يظهر بالأخضر ✅

### الخطوة 4: إنشاء قاعدة البيانات

1. افتح المتصفح على الجهاز الرئيسي
2. ادخل: **http://localhost/phpmyadmin**
3. اضغط **Import** من القائمة العلوية
4. استورد ملفات SQL **بهذا الترتيب** (ملف تلو الآخر):

```
الترتيب مهم! استورد كل ملف بشكل منفصل:

 1. database.sql              ← ينشئ قاعدة البيانات + جدول المستخدمين
 2. database_vehicles.sql
 3. database_vehicle_owners.sql
 4. database_agents.sql
 5. database_offices.sql
 6. database_drivers.sql
 7. database_notes.sql
 8. database_receipts.sql
 9. database_treasury.sql
10. database_vehicle_ledger.sql
11. database_bolsa_forms.sql
12. database_main_capital.sql
13. database_archive.sql
14. database_sync.sql
15. database_backup_metadata.sql
```

**لكل ملف:**
- اضغط **Import** → **Choose File** → اختر الملف → **Go**
- انتظر رسالة النجاح ✅ ثم انتقل للملف التالي

### الخطوة 5: إعداد المستخدمين

1. افتح المتصفح:
```
http://localhost/system52/karta/setup.php
```

2. ستظهر رسائل التأكيد:
   - ✅ جميع الجداول المطلوبة موجودة
   - ✅ تم إنشاء مستخدم: admin
   - ✅ تم إنشاء مستخدم: accountant

3. **⚠️ مهم:** بعد نجاح الإعداد، احذف ملف `setup.php`:
```
احذف: C:\xampp\htdocs\system52\karta\setup.php
```

### الخطوة 6: فحص النظام

افتح في المتصفح:
```
http://localhost/system52/karta/api/health/ping.php
```

يجب أن تظهر:
```json
{
  "success": true,
  "data": {
    "status": "ok",
    "mysql": "connected",
    "users_table": "exists"
  }
}
```

### الخطوة 7: تسجيل الدخول

افتح:
```
http://localhost/system52/karta/login.html
```

**بيانات الدخول:**

| الدور | اسم المستخدم | كلمة المرور |
|:---:|:---:|:---:|
| المدير | `admin` | `admin123` |
| المحاسب | `accountant` | `accountant123` |

---

## إعداد الشبكة (5 أجهزة)

### على جهاز السيرفر:

#### 1. اعرف IP السيرفر:
- افتح **CMD** (موجه الأوامر)
- اكتب: `ipconfig`
- ابحث عن **IPv4 Address** ضمن الشبكة المحلية
- مثال: `192.168.1.100`

#### 2. اسمح لـ Apache بالوصول من الشبكة:

افتح الملف:
```
C:\xampp\apache\conf\httpd.conf
```

ابحث عن:
```
Listen 80
```
تأكد أنها:
```
Listen 0.0.0.0:80
```
(وليست `Listen 127.0.0.1:80`)

#### 3. جدار الحماية (Windows Firewall):

- افتح **Windows Defender Firewall**
- اضغط **Allow an app through firewall**
- ابحث عن **Apache HTTP Server** — تأكد أنه مفعّل لـ **Private** ✅
- إذا غير موجود: اضغط **Allow another app** → تصفح إلى `C:\xampp\apache\bin\httpd.exe`

#### 4. أعد تشغيل Apache من XAMPP Control Panel

### على أجهزة العملاء (الأجهزة الأخرى):

افتح المتصفح وأدخل:
```
http://192.168.1.100/system52/karta/login.html
```
(استبدل `192.168.1.100` بـ IP السيرفر الفعلي)

**اختبر أولاً:**
```
http://192.168.1.100/system52/karta/api/health/ping.php
```
يجب أن تظهر `"mysql": "connected"` ✅

---

## بيانات الدخول

| الدور | اسم المستخدم | كلمة المرور | الصلاحيات |
|:---:|:---:|:---:|:---|
| **المدير** | `admin` | `admin123` | كل شيء: إيصالات + خزنة + بوالص + أرشيف + dashboard |
| **المحاسب** | `accountant` | `accountant123` | إيصالات + خزنة (بدون حذف أو إعدادات) |

---

## الاختبار بعد التثبيت

### اختبار سريع (من المتصفح):

1. **فحص الصحة:**
```
http://localhost/system52/karta/api/health/ping.php
```

2. **تسجيل دخول** → إنشاء إيصال → التأكد أنه يُحفظ

3. **من جهاز ثاني** → تسجيل دخول → التأكد أن الإيصال يظهر

### اختبار شامل (اختياري):

افتح من المتصفح أو CMD:
```
http://localhost/system52/karta/tests_v2/run_tests_v2.php
```
أو:
```
cd C:\xampp\htdocs\system52\karta
php tests_v2/run_tests_v2.php
```

---

## استكشاف الأخطاء

### مشكلة: "MySQL not connected"

- ✅ تأكد أن MySQL يعمل في XAMPP (أخضر)
- ✅ تأكد أن قاعدة `karta_erp` موجودة في phpMyAdmin
- ✅ تحقق من `config/database.php`:
  ```php
  'host'     => '127.0.0.1',
  'dbname'   => 'karta_erp',
  'username' => 'root',
  'password' => '',  // فارغة = الافتراضي في XAMPP
  ```

### مشكلة: الأجهزة الأخرى لا تستطيع الوصول

- ✅ تأكد أن كل الأجهزة على نفس الشبكة
- ✅ تحقق من IP السيرفر: `ipconfig` في CMD
- ✅ تأكد أن Apache يستمع على `0.0.0.0:80`
- ✅ أوقف جدار الحماية مؤقتاً للاختبار:
  ```
  netsh advfirewall set allprofiles state off
  ```
  (أعد تشغيله بعد التأكد: `netsh advfirewall set allprofiles state on`)

### مشكلة: صفحة بيضاء أو خطأ 500

- ✅ تحقق من سجل الأخطاء:
  ```
  C:\xampp\htdocs\system52\karta\logs\app.log
  C:\xampp\apache\logs\error.log
  ```
- ✅ تأكد أن PHP يعمل: افتح `http://localhost/system52/karta/api/health/ping.php`

### مشكلة: "لا يمكن تسجيل الدخول"

- ✅ تأكد أنك شغّلت `setup.php` (مرة واحدة)
- ✅ تأكد من كتابة اسم المستخدم وكلمة المرور بشكل صحيح
- ✅ جرّب: `admin` / `admin123`

### مشكلة: الخط العربي لا يظهر بشكل صحيح

- ✅ هذا طبيعي على LAN بدون إنترنت — خط Cairo يُحمّل من Google Fonts
- ✅ الحل: حمّل خط Cairo وضعه في مجلد المشروع (خطوة اختيارية)

---

## ملاحظات مهمة

### النسخ الاحتياطي

يوفر النظام طريقتين للنسخ الاحتياطي:

#### الطريقة 1: نسخ يدوي (JSON) — من المتصفح

1. سجّل دخول كـ **admin**
2. اضغط على زر **💾 نسخة احتياطية** في الشريط الجانبي
3. سيتم تحميل ملف JSON على جهازك
4. للاستعادة: اضغط **📥 استعادة** → اختر الملف → تأكيد

#### الطريقة 2: نسخ تلقائي (SQL) — كل 3 أيام

النظام يتضمن ملف batch جاهز للنسخ التلقائي عبر mysqldump.

**الإعداد (مرة واحدة):**

1. **أنشئ مجلد النسخ الاحتياطية:**
```
mkdir C:\karta-backups
```

2. **سجّل المهمة المجدولة** — افتح CMD واكتب:
```
schtasks /Create /TN "KartaERP-AutoBackup" /TR "C:\xampp\htdocs\system52\karta\scripts\karta-backup.bat" /SC DAILY /MO 3 /ST 02:00 /F
```

3. **فعّل تشغيل المهمة الفائتة:**
   - افتح **Task Scheduler** (جدولة المهام)
   - ابحث عن **KartaERP-AutoBackup**
   - اضغط يمين → **Properties** → تبويب **Settings**
   - ✅ فعّل: **"Run task as soon as possible after a scheduled start is missed"**
   - اضغط **OK**

**ما يحدث تلقائياً:**
- كل 3 أيام الساعة 02:00 صباحاً، يتم إنشاء نسخة SQL كاملة
- تُحفظ في: `C:\karta-backups\karta-auto-YYYY-MM-DD_HH-MM.sql`
- يُحتفظ بآخر 5 نسخ فقط (الأقدم تُحذف تلقائياً)
- يُسجّل النتيجة (نجاح/فشل) في: `C:\karta-backups\backup.log`
- إذا كان الجهاز مغلقاً وقت الـ backup → يُنفذ عند التشغيل

**التحقق من عمل النسخ التلقائي:**
```
type C:\karta-backups\backup.log
```
ابحث عن: `SUCCESS: Backup created`

**الاستعادة من نسخة SQL (عند الكوارث):**

1. أوقف Apache من XAMPP Control Panel
2. افتح CMD واكتب:
```
C:\xampp\mysql\bin\mysql.exe --user=root --host=127.0.0.1 --port=3306 karta_erp < "C:\karta-backups\karta-auto-2026-06-23_02-00.sql"
```
(استبدل اسم الملف بالنسخة المطلوبة)
3. أعد تشغيل Apache
4. افتح النظام في المتصفح → البيانات مُستعادة

**إلغاء المهمة المجدولة:**
```
schtasks /Delete /TN "KartaERP-AutoBackup" /F
```

### تغيير كلمات المرور

بعد التثبيت الأولي:
1. ادخل كـ `admin`
2. يمكن تغيير كلمات المرور من phpMyAdmin مباشرة:
   - جدول `users` → عدّل `password_hash`
   - استخدم: https://bcrypt-generator.com لتوليد hash جديد

### التوقيت

النظام يستخدم توقيت **Africa/Cairo** تلقائياً.
لا حاجة لتعديل أي إعداد.

### الأداء

النظام مُحسّن لـ LAN:
- كل البيانات المالية في MySQL (لا IndexedDB)
- كل العمليات ذرية (BEGIN/COMMIT/ROLLBACK)
- الجلسات تستمر 8 ساعات

---

## هيكل الروابط

| الصفحة | الرابط |
|--------|--------|
| تسجيل الدخول | `/system52/karta/login.html` |
| النظام الرئيسي | `/system52/karta/index.html` |
| فحص الصحة | `/system52/karta/api/health/ping.php` |
| phpMyAdmin | `/phpmyadmin` |
| الاختبارات | `/system52/karta/tests_v2/run_tests_v2.php` |

> استبدل `localhost` بـ IP السيرفر عند الدخول من أجهزة أخرى.
