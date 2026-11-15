#import <AppKit/AppKit.h>
#import <objc/runtime.h>

// Tao owns NSApplication's delegate. Extend that delegate in place so its
// launch, reopen, and URL callbacks keep working.
extern void mgland_open_new_window_from_dock(void);

static NSMenu *mgland_application_dock_menu(id self, SEL _cmd, NSApplication *application) {
  (void)_cmd;
  (void)application;
  NSMenu *menu = [[NSMenu alloc] initWithTitle:@""];
  NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:@"New Window"
                                               action:@selector(mglandNewWindowFromDock:)
                                        keyEquivalent:@""];
  item.target = self;
  [menu addItem:item];
  return menu;
}

static void mgland_new_window_from_dock(id self, SEL _cmd, id sender) {
  (void)self;
  (void)_cmd;
  (void)sender;
  mgland_open_new_window_from_dock();
}

bool mgland_install_dock_menu(void) {
  id delegate = NSApp.delegate;
  if (!delegate) return false;
  Class delegate_class = object_getClass(delegate);
  if (!delegate_class) return false;
  BOOL action_added = class_addMethod(delegate_class, @selector(mglandNewWindowFromDock:),
                                      (IMP)mgland_new_window_from_dock, "v@:@");
  if (!action_added) return false;
  BOOL menu_added = class_addMethod(delegate_class, @selector(applicationDockMenu:),
                                    (IMP)mgland_application_dock_menu, "@@:@");
  return menu_added && action_added;
}
