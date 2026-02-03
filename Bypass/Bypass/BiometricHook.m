// BiometricHook.m
// LAContext method swizzling implementation

#import "BiometricHook.h"
#import <objc/runtime.h>

static BOOL _bypassEnabled = YES;

@implementation BiometricHook

+ (void)load {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        [self initialize];
    });
}

+ (void)initialize {
    NSLog(@"[BiometricHook] Initializing LAContext hooks...");
    
    Class laContextClass = NSClassFromString(@"LAContext");
    if (!laContextClass) {
        NSLog(@"[BiometricHook] ERROR: LAContext class not found");
        return;
    }
    
    // Swizzle canEvaluatePolicy:error:
    [self swizzleMethod:@selector(canEvaluatePolicy:error:)
               withMethod:@selector(hooked_canEvaluatePolicy:error:)
                  inClass:laContextClass];
    
    // Swizzle evaluatePolicy:localizedReason:reply:
    [self swizzleMethod:@selector(evaluatePolicy:localizedReason:reply:)
               withMethod:@selector(hooked_evaluatePolicy:localizedReason:reply:)
                  inClass:laContextClass];
    
    // Swizzle biometryType (iOS 11+)
    [self swizzleMethod:@selector(biometryType)
               withMethod:@selector(hooked_biometryType)
                  inClass:laContextClass];
    
    // Swizzle evaluatedPolicyDomainState
    [self swizzleMethod:@selector(evaluatedPolicyDomainState)
               withMethod:@selector(hooked_evaluatedPolicyDomainState)
                  inClass:laContextClass];
    
    // Swizzle interactionNotAllowed property setter
    [self swizzleMethod:@selector(setInteractionNotAllowed:)
               withMethod:@selector(hooked_setInteractionNotAllowed:)
                  inClass:laContextClass];
    
    NSLog(@"[BiometricHook] LAContext hooks installed successfully");
}

+ (void)swizzleMethod:(SEL)originalSelector withMethod:(SEL)swizzledSelector inClass:(Class)class {
    Method originalMethod = class_getInstanceMethod(class, originalSelector);
    Method swizzledMethod = class_getInstanceMethod(self, swizzledSelector);
    
    if (!originalMethod) {
        NSLog(@"[BiometricHook] WARNING: Could not find method %@", NSStringFromSelector(originalSelector));
        return;
    }
    
    if (!swizzledMethod) {
        NSLog(@"[BiometricHook] WARNING: Could not find swizzled method %@", NSStringFromSelector(swizzledSelector));
        return;
    }
    
    BOOL didAddMethod = class_addMethod(class,
                                        originalSelector,
                                        method_getImplementation(swizzledMethod),
                                        method_getTypeEncoding(swizzledMethod));
    
    if (didAddMethod) {
        class_replaceMethod(class,
                           swizzledSelector,
                           method_getImplementation(originalMethod),
                           method_getTypeEncoding(originalMethod));
    } else {
        method_exchangeImplementations(originalMethod, swizzledMethod);
    }
}

+ (void)enableBypass:(BOOL)enabled {
    _bypassEnabled = enabled;
    NSLog(@"[BiometricHook] Bypass %@", enabled ? @"ENABLED" : @"DISABLED");
}

+ (BOOL)isBypassEnabled {
    return _bypassEnabled;
}

// Hook implementations
- (BOOL)hooked_canEvaluatePolicy:(LAPolicy)policy error:(NSError **)error {
    if ([BiometricHook isBypassEnabled]) {
        NSLog(@"[BiometricHook] canEvaluatePolicy bypassed - returning YES");
        if (error) {
            *error = nil;
        }
        return YES;
    }
    
    return [self hooked_canEvaluatePolicy:policy error:error];
}

- (void)hooked_evaluatePolicy:(LAPolicy)policy
              localizedReason:(NSString *)localizedReason
                        reply:(void (^)(BOOL success, NSError *error))reply {
    if ([BiometricHook isBypassEnabled]) {
        NSLog(@"[BiometricHook] evaluatePolicy bypassed - auto-succeeding");
        NSLog(@"[BiometricHook] Reason: %@", localizedReason);
        
        dispatch_async(dispatch_get_main_queue(), ^{
            if (reply) {
                reply(YES, nil);
            }
        });
        return;
    }
    
    [self hooked_evaluatePolicy:policy localizedReason:localizedReason reply:reply];
}

- (LABiometryType)hooked_biometryType {
    if ([BiometricHook isBypassEnabled]) {
        NSLog(@"[BiometricHook] biometryType bypassed - returning LABiometryTypeFaceID");
        return LABiometryTypeFaceID;
    }
    
    return [self hooked_biometryType];
}

- (NSData *)hooked_evaluatedPolicyDomainState {
    if ([BiometricHook isBypassEnabled]) {
        NSLog(@"[BiometricHook] evaluatedPolicyDomainState bypassed");
        static NSData *fakeState = nil;
        if (!fakeState) {
            fakeState = [@"BiometricBypassState" dataUsingEncoding:NSUTF8StringEncoding];
        }
        return fakeState;
    }
    
    return [self hooked_evaluatedPolicyDomainState];
}

- (void)hooked_setInteractionNotAllowed:(BOOL)interactionNotAllowed {
    if ([BiometricHook isBypassEnabled]) {
        NSLog(@"[BiometricHook] interactionNotAllowed bypassed - forcing NO");
        [self hooked_setInteractionNotAllowed:NO];
        return;
    }
    
    [self hooked_setInteractionNotAllowed:interactionNotAllowed];
}

@end
