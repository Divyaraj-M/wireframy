# Where this file goes

`Wireframy.md` is one note that does both jobs you asked for.

Put it at:

```
<garden vault>/1 - Projects/Curious Geeks/Products/Wireframy.md
```

Because `permalink` is `/wireframy/`, it publishes to **curiousgeekspm.com/wireframy** — not
`/products/wireframy/`. And because it sits in the `Products` folder, your existing dataview
table on `/products/` picks it up as a row, and that row links straight to `/wireframy`. One
file, no stub page, no extra click.

Then publish it with the Digital Garden command palette action.

## Two things in your Products setup that will bite you

Neither is caused by this file. Both are worth ten seconds.

**1. The table asks for a `title` field the template never sets.** `Products.md` selects
`title AS Product`, but `Products/_template.md` has no `title` in its frontmatter. Any product
added from that template shows a blank name in the table. This file sets `title: Wireframy`, so
its own row is fine. Add `title:` to the template and existing entries will need it too.

**2. `WHERE dg-publish = true` is probably not doing what it looks like.** Dataview reads
`dg-publish` as `dg` minus `publish` because of the hyphen. The bracket form is safer:

```
WHERE file.frontmatter["dg-publish"] = true
```

Right now the clause likely evaluates to null for every row, which means the filter is not
filtering. It happens to look correct because everything in that folder is published.

## Images

The page pulls five images from your public repo:

```
https://raw.githubusercontent.com/Divyaraj-M/wireframy/main/docs/tour.gif
https://raw.githubusercontent.com/Divyaraj-M/wireframy/main/docs/editor.png
https://raw.githubusercontent.com/Divyaraj-M/wireframy/main/docs/icons.png
https://raw.githubusercontent.com/Divyaraj-M/wireframy/main/docs/logo-512.png   (social preview)
```

That works with no setup and I checked all of them return 200. It is also the fragile part:
`raw.githubusercontent.com` is not a CDN, GitHub discourages hotlinking it, and the hero gif is
462KB. If the hero ever fails to load, the page has no hero.

The sturdier version is to copy the four files into your garden vault and swap the URLs for
vault embeds, which also lets Digital Garden compress them:

```
![[tour.gif]]
![[editor.png]]
![[icons.png]]
```

The four files are attached alongside this note.
