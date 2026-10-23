public class OrderService {
    public static void process() {
        Integer a = 1;
        Integer b = 2;
        try {
            validate(a);
            System.debug('after validate');
        } catch (Exception e) {
            System.debug('caught ' + e.getMessage());
            logError(e);
        }
        System.debug('continued');
    }
    public static void validate(Integer x) {
        Integer y = x + 1;
        String s = null;
        s.length();
        System.debug('unreachable');
    }
    public static void logError(Exception e) {
        System.debug('log ' + e);
    }
}
