# Email Templates

This directory contains email templates for the notifications service using **Handlebars** templating engine.

## Template Structure

Each template consists of three files:
- `{template-name}.subject` - Email subject line (Handlebars template)
- `{template-name}.html` - HTML email body (Handlebars template)
- `{template-name}.txt` - Plain text email body (Handlebars template)

## Handlebars Syntax

Templates use standard Handlebars syntax. See [Handlebars Documentation](https://handlebarsjs.com/guide/) for full details.

### Basic Variable Replacement
```handlebars
{{variableName}}
{{object.property}}
{{#if variable}}...{{/if}}
```

### Conditionals
```handlebars
{{#if condition}}
  Content shown if condition is truthy
{{else}}
  Content shown if condition is falsy
{{/if}}
```

### Loops
```handlebars
{{#each items}}
  {{this}} - Current item
  {{@index}} - Current index (0-based)
  {{@first}} - True if first item
  {{@last}} - True if last item
{{/each}}
```

### Built-in Helpers

The following custom helpers are available:

- `{{formatDate date}}` - Format a date
- `{{uppercase str}}` - Convert string to uppercase
- `{{lowercase str}}` - Convert string to lowercase
- `{{eq a b}}` - Check if a equals b
- `{{ne a b}}` - Check if a does not equal b

### Example Template

**welcome.subject:**
```
Welcome to {{appName}}!
```

**welcome.html:**
```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Welcome</title>
  </head>
  <body>
    <h1>Welcome to {{appName}}!</h1>
    <p>Hi {{userName}},</p>
    {{#if message}}
    <p>{{message}}</p>
    {{/if}}
  </body>
</html>
```

## Available Templates

### 1. `verify-code`
Email verification template with 6-digit code.

**Required Variables:**
- `{{code}}` - 6-digit verification code

**Optional Variables:**
- `{{expiryTime}}` - Code expiration time (e.g., "10 minutes")
- `{{userName}}` - User's full name or email
- `{{appName}}` - Application name

**Example Usage:**
```typescript
{
  template: 'verify-code',
  data: {
    code: '123456',
    expiryTime: '10 minutes'
  }
}
```

### 2. `forgot-password`
Password reset template with 6-digit code.

**Required Variables:**
- `{{code}}` - 6-digit password reset code

**Optional Variables:**
- `{{expiryTime}}` - Code expiration time (e.g., "15 minutes")
- `{{resetUrl}}` - Optional password reset URL
- `{{userName}}` - User's full name or email
- `{{appName}}` - Application name

**Example Usage:**
```typescript
{
  template: 'forgot-password',
  data: {
    code: '654321',
    expiryTime: '15 minutes',
    resetUrl: 'https://example.com/reset?token=abc123' // Optional
  }
}
```

## Creating New Templates

1. Create three files: `{name}.subject`, `{name}.html`, and `{name}.txt`
2. Use Handlebars syntax for dynamic content
3. Templates are automatically compiled and cached on first use
4. The template will be available immediately

## Usage in Code

When sending a notification, specify the template name:

```typescript
await notificationsService.send({
  recipientUserId: 'user-id',
  title: 'Welcome!',
  body: 'Welcome to our app',
  channels: ['email'],
  template: 'welcome', // Template name (without extension)
  data: {
    // Template data available in Handlebars templates
    appName: 'My App',
    userName: 'John Doe',
    message: 'Thank you for joining!'
  }
});
```

If no template is specified, the default `notification` template will be used (if it exists).

## Template Data

The following data is automatically available in all templates:

- `{{userName}}` - User's full name or email
- `{{userEmail}}` - User's email address
- `{{userId}}` - User's ID
- `{{title}}` - Notification title
- `{{body}}` - Notification body
- `{{appName}}` - Application name (from config or data)

Additional data can be passed via the `data` field in the DTO.

