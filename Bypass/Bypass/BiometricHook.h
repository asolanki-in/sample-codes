// BiometricHook.h
// Header file defining the biometric bypass interface

#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>

@interface BiometricHook : NSObject

+ (void)initialize;
+ (void)enableBypass:(BOOL)enabled;
+ (BOOL)isBypassEnabled;

@end
