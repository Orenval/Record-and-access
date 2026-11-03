# Access Control Attack Table & Evidence

**Date:** 2026-11-01  
**Environment:** Live Next.js application (`http://localhost:3000`)  
**Test Users:**  
- **Alice:** `alice@test.bookmark` (`User.id: cmvi771tc0000kktzhaqk7m2s`)  
- **Bob:** `bob@test.bookmark` (`User.id: cmvi772dd0000nwtzavrrd76g`)  
**Target Resource (`ALICE_ID`):** `4QNxK5vfsj4K` (`"Alice First Bookmark"`, URL: `https://alice.example.com/one`)  
**Raw Terminal Log File:** [`evidence/attack-log.txt`](./attack-log.txt)

---

## 1. Access Control Attack Table

> **Note on CSRF Token:** Mutating endpoints (`POST`, `DELETE`) require a double-submit CSRF token matching the cookie in the user's cookie jar. Bob's active CSRF token is `6615fedcbd25162d0464333c81101cbf5bae5651adad90a833d8a28265144dbc` from `evidence/bob-cookies.txt`.

| # | Method | Path | What was attempted (exact command executed) | Actual status code | Actual response body | Expected | Pass / Fail |
|---|---|---|---|---|---|---|---|
| 1 | GET | `/api/bookmarks` | `curl.exe -i http://localhost:3000/api/bookmarks` | `401 Unauthorized` | `{"success":false,"message":"Not authenticated"}` | 401 | **PASS** |
| 2 | GET | `/api/bookmarks` | `curl.exe -i -b evidence/bob-cookies.txt http://localhost:3000/api/bookmarks` | `200 OK` | `{"success":true,"message":"Bookmarks retrieved","data":{"bookmarks":[{"publicId":"TtLYYmyAD9Qt","label":"Bob Only Bookmark","url":"https://bob.example.com/only"}]}}` | 200 (only Bob's bookmarks) | **PASS** |
| 3 | GET | `/api/bookmarks/4QNxK5vfsj4K` | `curl.exe -i -b evidence/bob-cookies.txt http://localhost:3000/api/bookmarks/4QNxK5vfsj4K` | `404 Not Found` | `{"success":false,"message":"Bookmark not found"}` | 404 | **PASS** |
| 4 | GET | `/api/bookmarks/nonexistent99` | `curl.exe -i -b evidence/bob-cookies.txt http://localhost:3000/api/bookmarks/nonexistent99` | `404 Not Found` | `{"success":false,"message":"Bookmark not found"}` | 404 (byte-identical to row 3) | **PASS** |
| 5 | GET | `/api/bookmarks/4QNxK5vfsj4K` | `curl.exe -i http://localhost:3000/api/bookmarks/4QNxK5vfsj4K` | `401 Unauthorized` | `{"success":false,"message":"Not authenticated"}` | 401 | **PASS** |
| 6 | DELETE | `/api/bookmarks/4QNxK5vfsj4K` | `curl.exe -i -b evidence/bob-cookies.txt -H "x-csrf-token: 6615fedcbd25162d0464333c81101cbf5bae5651adad90a833d8a28265144dbc" -X DELETE http://localhost:3000/api/bookmarks/4QNxK5vfsj4K` | `404 Not Found` | `{"success":false,"message":"Bookmark not found"}` | 404 | **PASS** |
| 6b | GET | `/api/bookmarks/4QNxK5vfsj4K` | *(Post-Attack 6 Alice check)* `curl.exe -i -b evidence/alice-cookies.txt http://localhost:3000/api/bookmarks/4QNxK5vfsj4K` | `200 OK` | `{"success":true,"message":"Bookmark retrieved","data":{"bookmark":{"publicId":"4QNxK5vfsj4K","label":"Alice First Bookmark","url":"https://alice.example.com/one"}}}` | 200 (Alice bookmark survived) | **PASS** |
| 7 | DELETE | `/api/bookmarks/4QNxK5vfsj4K` | `curl.exe -i -b evidence/bob-cookies.txt -X DELETE http://localhost:3000/api/bookmarks/4QNxK5vfsj4K` | `403 Forbidden` | `{"success":false,"message":"Invalid CSRF token"}` | 403 | **PASS** |
| 7b | GET | `/api/bookmarks/4QNxK5vfsj4K` | *(Post-Attack 7 Alice check)* `curl.exe -i -b evidence/alice-cookies.txt http://localhost:3000/api/bookmarks/4QNxK5vfsj4K` | `200 OK` | `{"success":true,"message":"Bookmark retrieved","data":{"bookmark":{"publicId":"4QNxK5vfsj4K","label":"Alice First Bookmark","url":"https://alice.example.com/one"}}}` | 200 (Alice bookmark survived) | **PASS** |
| 8 | DELETE | `/api/bookmarks/4QNxK5vfsj4K` | `curl.exe -i -X DELETE http://localhost:3000/api/bookmarks/4QNxK5vfsj4K` | `401 Unauthorized` | `{"success":false,"message":"Not authenticated"}` | 401 | **PASS** |
| 8b | GET | `/api/bookmarks/4QNxK5vfsj4K` | *(Post-Attack 8 Alice check)* `curl.exe -i -b evidence/alice-cookies.txt http://localhost:3000/api/bookmarks/4QNxK5vfsj4K` | `200 OK` | `{"success":true,"message":"Bookmark retrieved","data":{"bookmark":{"publicId":"4QNxK5vfsj4K","label":"Alice First Bookmark","url":"https://alice.example.com/one"}}}` | 200 (Alice bookmark survived) | **PASS** |
| 9 | POST | `/api/bookmarks` | `curl.exe -i -H "Content-Type: application/json" -d @evidence/generic-bm.json -X POST http://localhost:3000/api/bookmarks` | `401 Unauthorized` | `{"success":false,"message":"Not authenticated"}` | 401 | **PASS** |
| 10 | POST | `/api/bookmarks` | `curl.exe -i -b evidence/bob-cookies.txt -H "Content-Type: application/json" -d @evidence/bob-bm1.json -X POST http://localhost:3000/api/bookmarks` | `403 Forbidden` | `{"success":false,"message":"Invalid CSRF token"}` | 403 | **PASS** |
| 11 | POST | `/api/bookmarks` | `curl.exe -i -b evidence/bob-cookies.txt -H "Content-Type: application/json" -H "x-csrf-token: 6615fedcbd25162d0464333c81101cbf5bae5651adad90a833d8a28265144dbc" -d @evidence/attack11-forged.json -X POST http://localhost:3000/api/bookmarks` | `201 Created` | `{"success":true,"message":"Bookmark created","data":{"bookmark":{"publicId":"y6q30c_P3q3a","label":"Bob Forged Bookmark","url":"https://forged.example.com"}}}` | 201 (created under Bob; forged userId ignored) | **PASS** |
| 12 | GET | `/bookmarks/4QNxK5vfsj4K` | `curl.exe -i -b evidence/bob-cookies.txt http://localhost:3000/bookmarks/4QNxK5vfsj4K` | `404 Not Found` | Rendered standard 404 HTML; Alice's label `"Alice First Bookmark"` and URL `"https://alice.example.com/one"` completely absent | 404 (no Alice data in HTML) | **PASS** |
| 13 | GET | `/bookmarks` | `curl.exe -i http://localhost:3000/bookmarks` | `307 Temporary Redirect` | `location: /signin` (redirects unauthenticated browser client to sign-in) | 307 redirect to /signin | **PASS** |

---

## 2. Row 3 vs Row 4 Side-by-Side Comparison Table

Comparison between requesting another user's bookmark (IDOR probe) versus requesting a completely non-existent bookmark identifier:

| Property | Row 3 (Other User's Bookmark: `ALICE_ID`) | Row 4 (Nonexistent Bookmark Identifier) | Match Assessment |
|---|---|---|---|
| **Request Command** | `curl.exe -i -b evidence/bob-cookies.txt http://localhost:3000/api/bookmarks/4QNxK5vfsj4K` | `curl.exe -i -b evidence/bob-cookies.txt http://localhost:3000/api/bookmarks/nonexistent99` | Same authentication context (Bob) |
| **HTTP Status Code** | `404 Not Found` | `404 Not Found` | **Identical** (`404`) |
| **Content-Type** | `application/json` | `application/json` | **Identical** |
| **Response Body** | `{"success":false,"message":"Bookmark not found"}` | `{"success":false,"message":"Bookmark not found"}` | **Identical** |
| **Payload Byte Length**| 50 bytes | 50 bytes | **Byte-Identical** (50 bytes) |
| **Anti-Enumeration Result** | No distinction between "record exists but belongs to another user" and "record does not exist". | Prevents attackers from using status codes or response lengths to map valid identifiers. | **PASS** (Zero enumeration leakage) |

---

## 3. Row 11 Database Ownership Verification

### Attack Scenario
In Attack 11, Bob submitted a creation payload (`evidence/attack11-forged.json`) attempting to force ownership of the new bookmark to Alice by explicitly supplying Alice's user ID:
```json
{
  "label": "Bob Forged Bookmark",
  "url": "https://forged.example.com",
  "userId": "cmvi771tc0000kktzhaqk7m2s"
}
```

### Database Query Executed
Direct query executed against the PostgreSQL database:
```sql
SELECT b."publicId", b.label, b."userId", u.email 
FROM "Bookmark" b 
JOIN "User" u ON b."userId" = u.id 
WHERE b.label = 'Bob Forged Bookmark';
```

### Actual Query Result
```json
[
  {
    "publicId": "y6q30c_P3q3a",
    "label": "Bob Forged Bookmark",
    "userId": "cmvi772dd0000nwtzavrrd76g",
    "email": "bob@test.bookmark"
  }
]
```

### Ownership Verification Summary
- **Supplied `userId` in Body:** `cmvi771tc0000kktzhaqk7m2s` (Alice) &rarr; **Ignored and stripped** by Zod schema validation.
- **Assigned `userId` in Database:** `cmvi772dd0000nwtzavrrd76g` (Bob) &rarr; **Enforced strictly** from the validated server-side session (`sessionData.session.userId`).
- **Owner Account:** `bob@test.bookmark`
- **Result:** **PASS**. Client cannot spoof record ownership.
