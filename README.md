# Video Proxy Server

שרת Node.js פשוט המשמש כ-proxy להורדת קבצי וידאו/אודיו מה-CDN של YouTube ופלטפורמות אחרות, תוך עקיפת מגבלות CORS ו-403 Forbidden.

## מדוע זה נדרש?

כאשר מנסים להוריד סרטונים ישירות מ-YouTube באמצעות JavaScript, לעיתים קרובות נתקלים בשגיאות CORS או 403 Forbidden. שרת ה-proxy מאפשר לעקוף מגבלות אלו על ידי ביצוע הבקשה מצד השרת.

## שימוש מקומי

התקן ורוץ מקומית:

```bash
npm install
npm start
```

גישה ל:

```
http://localhost:3000/proxy?url=https://example.com/video.mp4
```

## פריסה ב-Render

1. העלה את הריפוזיטורי ל-GitHub
2. גש ל-[Render](https://render.com)
3. צור שירות Web חדש
4. הגדר:
   - Build Command: `npm install`
   - Start Command: `npm start`

## כיצד להתמודד עם שגיאות "Too Many Requests"

שרת ה-proxy כולל אמצעים חכמים כדי להתמודד עם מגבלות קצב:

1. **ניסיונות חוזרים עם Exponential Backoff** - השרת ינסה שוב באופן אוטומטי כאשר הוא נתקל בשגיאת 429 Too Many Requests
2. **הגבלת קצב פנימית** - מוגדר מקסימום של 10 בקשות לדקה לכל כתובת IP
3. **כיבוד Retry-After** - אם שרת המקור מספק את כותרת Retry-After, השרת שלנו ימתין בהתאם

## טיפול בבעיות נפוצות

- **שגיאת 429 (Too Many Requests)**: המתן מספר דקות ונסה שוב. YouTube מגביל את מספר הבקשות שניתן לשלוח
- **שגיאת 404 (Not Found)**: הכתובת שגויה או שאין גישה למשאב
- **שגיאת 403 (Forbidden)**: הוסף כותרות מתאימות או נסה URL אחר

## עדכון פרמטרי הגבלת קצב

אם אתה נתקל בשגיאות 429 באופן תדיר, שקול להתאים את הערכים הבאים ב-server.js:

```javascript
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 10; // 10 requests per minute per IP
```

## אבטחה

מומלץ:
1. הגבל את הגישה ל-proxy רק למקורות מורשים
2. הוסף אימות בסיסי אם משתמשים בזה בסביבת ייצור
3. נטר את התעבורה לזיהוי שימוש לרעה